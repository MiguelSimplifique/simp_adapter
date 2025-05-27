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
    // n8n envia automaticamente: "Bearer API_KEY"
    const authHeader = req.headers.authorization;
    console.log('Authorization header recebido:', authHeader);
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      console.error('Authorization header inválido ou ausente');
      return res.status(401).json({
        error: {
          message: 'Authorization header missing or invalid',
          type: 'authentication_error',
          details: 'Expected format: Bearer TOKEN:UUID'
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
      // Parse do formato n8n
      const messageString = messages[0];
      
      // Extrair System message para custom_base_system_prompt
      const systemMatch = messageString.match(/System:\s*([\s\S]*?)(?=Contexto Extra|$)/);
      if (systemMatch) {
        customSystemPrompt = systemMatch[1].trim();
        console.log('System prompt extraído do formato string');
      }
      
      // Extrair seção "Contexto Extra Human:"
      const contextoMatch = messageString.match(/Contexto Extra\s*Human:\s*([\s\S]*?)$/);
      if (contextoMatch) {
        const contextoContent = contextoMatch[1].trim();
        
        // Extrair Query
        const queryMatch = contextoContent.match(/Query:\s*([\s\S]*?)(?=user_key:|$)/);
        if (queryMatch) {
          userQuery = queryMatch[1].trim();
        }
        
        // Extrair user_key
        const userKeyMatch = contextoContent.match(/user_key:\s*(.+?)$/);
        if (userKeyMatch) {
          userKey = userKeyMatch[1].trim();
        }
      }
      
      // Fallback: se não encontrou no formato esperado, tenta o formato antigo
      if (!userQuery) {
        const humanMatch = messageString.match(/Human:\s*([\s\S]*?)$/);
        if (humanMatch) {
          userQuery = humanMatch[1].trim();
        }
      }
    } else {
    
    // Validar se há uma query
    if (!userQuery) {
      console.error('No user query found in messages:', openaiRequest.messages);
      return res.status(400).json({
        error: {
          message: 'No user message found',
          type: 'invalid_request_error',
          details: 'A user message (Query: or role: user) is required'
        }
      });
    }
    
    // Determinar user_key com fallback
    // Prioridade: 1) UserKey na mensagem, 2) user no request, 3) header customizado, 4) gerar único
    if (!userKey) {
      userKey = openaiRequest.user || 
                req.headers['x-user-key'] || 
                req.headers['x-user-id'] ||
                `n8n-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }
    
    console.log('User Key:', userKey);
    
    // Preparar payload para Simplifique.ai conforme documentação
    const simplifiqueRequest = {
      chatbot_uuid: chatbotUuid,
      query: userQuery,
      user_key: userKey
    };
    
    // Adicionar custom_base_system_prompt apenas se existir e não estiver vazio
    if (customSystemPrompt && customSystemPrompt.trim()) {
      simplifiqueRequest.custom_base_system_prompt = customSystemPrompt;
    }
    
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
      console.log('\n=== Resposta enviada para n8n ===');
      console.log('Success!');
      
    } catch (axiosError) {
      console.error('\n=== Erro ao chamar Simplifique.ai ===');
      console.error('Erro completo:', axiosError.response?.data || axiosError.message);
      console.error('Status:', axiosError.response?.status);
      console.error('Headers:', axiosError.response?.headers);
      
      throw axiosError; // Re-throw para o tratamento geral
    }
    
  } catch (error) {
    console.error('\n=== Erro no proxy ===');
    console.error('Tipo:', error.name);
    console.error('Mensagem:', error.message);
    console.error('Stack:', error.stack);
    
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
