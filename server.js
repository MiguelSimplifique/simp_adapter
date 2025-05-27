const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

// Configurações
const SIMPLIFIQUE_BASE_URL = 'https://app.simplifique.ai/en/chatbot/api/v1'; // Corrigido: era /pt/, agora /en/
const PORT = process.env.PORT || 3000;

// Middleware para logging (opcional)
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Endpoint principal que emula OpenAI Chat Completions
app.post('/v1/chat/completions', async (req, res) => {
  console.log('\n=== Nova requisição recebida ===');
  console.log('Headers:', JSON.stringify(req.headers, null, 2));
  console.log('Body:', JSON.stringify(req.body, null, 2));
  
  try {
    const openaiRequest = req.body;
    
    // Extrair token e UUID do cabeçalho Authorization
    // Formato esperado: "Bearer TOKEN:UUID"
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      console.error('Authorization header inválido ou ausente');
      return res.status(401).json({
        error: {
          message: 'Authorization header missing or invalid',
          type: 'authentication_error'
        }
      });
    }
    
    // Parse do token e UUID
    const authData = authHeader.replace('Bearer ', '').trim();
    const [apiToken, chatbotUuid] = authData.split(':');
    
    console.log('Token extraído:', apiToken ? `${apiToken.substring(0, 10)}...` : 'VAZIO');
    console.log('UUID extraído:', chatbotUuid || 'VAZIO');
    
    // Validar formato UUID (básico)
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(chatbotUuid)) {
      console.error('UUID inválido:', chatbotUuid);
      return res.status(400).json({
        error: {
          message: 'Invalid chatbot UUID format',
          type: 'invalid_request_error',
          details: `UUID deve estar no formato: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`
        }
      });
    }
    
    // Extrair e processar mensagens do formato OpenAI
    let messages = openaiRequest.messages || [];
    
    // Verificar se as mensagens vêm como string única (formato n8n)
    if (messages.length === 1 && typeof messages[0] === 'string') {
      // Parse do formato n8n: "System: ... Human: ..."
      const messageString = messages[0];
      const parsedMessages = [];
      
      // Extrair System message
      const systemMatch = messageString.match(/System:\s*([\s\S]*?)(?=Human:|$)/);
      if (systemMatch) {
        parsedMessages.push({
          role: 'system',
          content: systemMatch[1].trim()
        });
      }
      
      // Extrair Human/User message
      const humanMatch = messageString.match(/Human:\s*([\s\S]*?)$/);
      if (humanMatch) {
        parsedMessages.push({
          role: 'user',
          content: humanMatch[1].trim()
        });
      }
      
      messages = parsedMessages;
    }
    
    // Validar se há mensagens
    const lastMessage = messages[messages.length - 1];
    if (!lastMessage || !lastMessage.content) {
      console.error('Invalid message format:', openaiRequest.messages);
      return res.status(400).json({
        error: {
          message: 'No valid message content found',
          type: 'invalid_request_error',
          details: 'Messages must be in OpenAI format or n8n string format'
        }
      });
    }
    
    // Gerar user_key único para cada sessão (pode ser customizado)
    const userKey = openaiRequest.user || `n8n-user-${Date.now()}`;
    
    // Extrair e traduzir System Message para custom_base_system_prompt
    let customSystemPrompt = '';
    const systemMessage = messages.find(msg => msg.role === 'system');
    if (systemMessage && systemMessage.content) {
      customSystemPrompt = systemMessage.content;
      console.log('System Message detectada, será enviada como custom_base_system_prompt');
    }
    
    // Preparar payload para Simplifique.ai
    const simplifiqueRequest = {
      chatbot_uuid: chatbotUuid,
      query: lastMessage.content,
      user_key: userKey,
      // Incluir custom_base_system_prompt se houver System Message
      ...(customSystemPrompt && { custom_base_system_prompt: customSystemPrompt })
    };
    
    console.log('\n=== Enviando para Simplifique.ai ===');
    console.log('URL:', `${SIMPLIFIQUE_BASE_URL}/message/`);
    console.log('Payload:', JSON.stringify(simplifiqueRequest, null, 2));
    
    // Chamar API da Simplifique.ai
    try {
      const simplifiqueResponse = await axios.post(
        `${SIMPLIFIQUE_BASE_URL}/message/`,
        simplifiqueRequest,
        {
          headers: {
            'Authorization': `Token ${apiToken}`, // Formato correto: "Token" não "Bearer"
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          timeout: 30000 // 30 segundos de timeout
        }
      );
      
      console.log('\n=== Resposta da Simplifique.ai ===');
      console.log('Status:', simplifiqueResponse.status);
      console.log('Data:', JSON.stringify(simplifiqueResponse.data, null, 2));
      
      const simplifiqueData = simplifiqueResponse.data;
    
    // Traduzir resposta para formato OpenAI
    const openaiResponse = {
      id: `chatcmpl-${uuidv4()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: openaiRequest.model || 'gpt-3.5-turbo',
      system_fingerprint: `simplifique_${chatbotUuid}`,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: simplifiqueData.data.answer
        },
        logprobs: null,
        finish_reason: 'stop'
      }],
      usage: {
        prompt_tokens: Math.ceil(lastMessage.content.length / 4),
        completion_tokens: Math.ceil(simplifiqueData.data.answer.length / 4),
        total_tokens: Math.ceil((lastMessage.content.length + simplifiqueData.data.answer.length) / 4)
      },
      // Metadados adicionais da Simplifique
      metadata: {
        simplifique_chat_id: simplifiqueData.data.chat_id,
        service: 'simplifique.ai'
      }
    };
    
    res.json(openaiResponse);
    
  } catch (error) {
    console.error('Proxy error:', error.response?.data || error.message);
    
    // Tratamento de erros específicos da Simplifique.ai
    if (error.response) {
      const status = error.response.status;
      const errorData = error.response.data;
      
      if (status === 401) {
        return res.status(401).json({
          error: {
            message: errorData.detail || 'Invalid API token',
            type: 'authentication_error'
          }
        });
      }
      
      if (status === 400) {
        return res.status(400).json({
          error: {
            message: errorData.message || 'Invalid request parameters',
            type: 'invalid_request_error',
            details: errorData.errors
          }
        });
      }
    }
    
    // Erro genérico
    res.status(500).json({
      error: {
        message: 'Internal server error',
        type: 'api_error',
        details: error.message
      }
    });
  }
});

// Endpoint de health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Simplifique.ai OpenAI Proxy',
    timestamp: new Date().toISOString(),
    environment: {
      node_env: process.env.NODE_ENV || 'not set',
      port: PORT,
      simplifique_url: SIMPLIFIQUE_BASE_URL
    }
  });
});

// Endpoint de debug (remover em produção)
app.get('/debug/test', (req, res) => {
  res.json({
    message: 'Debug endpoint working',
    headers: req.headers,
    timestamp: new Date().toISOString()
  });
});

// Endpoint para listar modelos (compatibilidade com OpenAI)
app.get('/v1/models', (req, res) => {
  res.json({
    data: [
      {
        id: 'simplifique-default',
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'simplifique.ai'
      }
    ]
  });
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`Simplifique.ai OpenAI Proxy rodando na porta ${PORT}`);
  console.log(`Health check disponível em: http://localhost:${PORT}/health`);
});

// Tratamento de shutdown gracioso
process.on('SIGTERM', () => {
  console.log('SIGTERM recebido, encerrando servidor...');
  process.exit(0);
});
