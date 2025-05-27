const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

// Configurações
const SIMPLIFIQUE_BASE_URL = 'https://app.simplifique.ai/pt/chatbot/api/v1';
const PORT = process.env.PORT || 3000;

// Middleware para logging (opcional)
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Endpoint principal que emula OpenAI Chat Completions
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const openaiRequest = req.body;
    
    // Extrair token e UUID do cabeçalho Authorization
    // Formato esperado: "Bearer TOKEN:UUID"
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
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
    
    if (!apiToken || !chatbotUuid) {
      return res.status(401).json({
        error: {
          message: 'Token and UUID must be provided in format: Bearer TOKEN:UUID',
          type: 'authentication_error'
        }
      });
    }
    
    // Extrair a mensagem do formato OpenAI
    const messages = openaiRequest.messages || [];
    const lastMessage = messages[messages.length - 1];
    
    if (!lastMessage || !lastMessage.content) {
      return res.status(400).json({
        error: {
          message: 'No message content found',
          type: 'invalid_request_error'
        }
      });
    }
    
    // Gerar user_key único para cada sessão (pode ser customizado)
    const userKey = openaiRequest.user || `n8n-user-${Date.now()}`;
    
    // Construir system prompt se houver
    let customSystemPrompt = '';
    const systemMessage = messages.find(msg => msg.role === 'system');
    if (systemMessage) {
      customSystemPrompt = systemMessage.content;
    }
    
    // Preparar payload para Simplifique.ai
    const simplifiqueRequest = {
      chatbot_uuid: chatbotUuid,
      query: lastMessage.content,
      user_key: userKey,
      ...(customSystemPrompt && { custom_base_system_prompt: customSystemPrompt })
    };
    
    console.log('Calling Simplifique.ai with:', {
      url: `${SIMPLIFIQUE_BASE_URL}/message/`,
      chatbot_uuid: chatbotUuid,
      query: simplifiqueRequest.query.substring(0, 50) + '...'
    });
    
    // Chamar API da Simplifique.ai
    const simplifiqueResponse = await axios.post(
      `${SIMPLIFIQUE_BASE_URL}/message/`,
      simplifiqueRequest,
      {
        headers: {
          'Authorization': `Token ${apiToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      }
    );
    
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
