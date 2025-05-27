const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

const app = express();
const SIMPLIFIQUE_BASE_URL = 'https://app.simplifique.ai/pt/chatbot/api/v1';
const PORT = process.env.PORT || 3000;

// 1️⃣ Logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.originalUrl}`);
  next();
});

// 2️⃣ Middleware para parsing de JSON
app.use(express.json());

// 3️⃣ Endpoint principal
app.post('/v1/chat/completions', async (req, res) => {
  console.log('\n=== Nova requisição recebida ===');
  console.log('Headers:', JSON.stringify(req.headers, null, 2));
  console.log('Body:', JSON.stringify(req.body, null, 2));

  try {
    const openaiRequest = req.body;
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        error: {
          message: 'Authorization header missing or invalid',
          type: 'authentication_error',
          details: 'Expected format: Bearer TOKEN:UUID'
        }
      });
    }

    const authData = authHeader.replace('Bearer ', '').trim();
    const [apiToken, chatbotUuid] = authData.split(':');

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(chatbotUuid)) {
      return res.status(400).json({
        error: {
          message: 'Invalid chatbot UUID format',
          type: 'invalid_request_error',
          details: `UUID deve estar no formato: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`
        }
      });
    }

    let messages = openaiRequest.messages || [];
    let customSystemPrompt = '';
    let userQuery = '';
    let userKey = '';
    let lastMessage = null;

    // Compatível com formato string (n8n) e OpenAI
    if (messages.length === 1 && typeof messages[0] === 'string') {
      const messageString = messages[0];

      // Extrair System Prompt
      const systemMatch = messageString.match(/System:\s*([\s\S]*?)(?=Contexto Extra|$)/);
      if (systemMatch) {
        customSystemPrompt = systemMatch[1].trim();
      }

      // Extrair seção "Contexto Extra Human:"
      const contextoMatch = messageString.match(/Contexto Extra\s*Human:\s*([\s\S]*?)$/);
      if (contextoMatch) {
        const contextoContent = contextoMatch[1].trim();

        // Extrair Query entre Query: e user_key:
        const queryMatch = contextoContent.match(/Query:\s*([\s\S]*?)\s*user_key:/i);
        if (queryMatch) {
          userQuery = queryMatch[1].trim();
        }

        // Extrair user_key
        const userKeyMatch = contextoContent.match(/user_key:\s*([^\n\r]*)/i);
        if (userKeyMatch) {
          userKey = userKeyMatch[1].trim();
        }
      }

      // Fallback para Human (caso não encontre no contexto extra)
      if (!userQuery) {
        const humanMatch = messageString.match(/Human:\s*([^\n\r]*)/);
        if (humanMatch) {
          userQuery = humanMatch[1].trim();
        }
      }

      if (userQuery) {
        lastMessage = { role: 'user', content: userQuery };
      }
    } else {
      lastMessage = messages[messages.length - 1];
      if (!userQuery && lastMessage?.content) {
        userQuery = lastMessage.content.trim();
      }
    }

    // Checagem obrigatória da query
    if (!userQuery) {
      return res.status(400).json({
        error: {
          message: 'No user message found',
          type: 'invalid_request_error',
          details: 'A user message (Query: or role: user) is required'
        }
      });
    }

    // Checagem obrigatória do user_key (pode usar fallback de headers ou gerar)
    if (!userKey) {
      userKey = openaiRequest.user ||
                req.headers['x-user-key'] ||
                req.headers['x-user-id'] ||
                `n8n-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    const simplifiqueRequest = {
      chatbot_uuid: chatbotUuid,
      query: userQuery,
      user_key: userKey
    };

    if (customSystemPrompt && customSystemPrompt.trim()) {
      simplifiqueRequest.custom_base_system_prompt = customSystemPrompt;
    }

    console.log('\n=== Enviando para Simplifique.ai ===');
    console.log('Payload:', JSON.stringify(simplifiqueRequest, null, 2));

    try {
      const simplifiqueResponse = await axios.post(
        `${SIMPLIFIQUE_BASE_URL}/message/`,
        simplifiqueRequest,
        {
          headers: {
            'Authorization': `Token ${apiToken}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          timeout: 30000
        }
      );

      const simplifiqueData = simplifiqueResponse.data;
      const promptTokens = lastMessage?.content
        ? Math.ceil(lastMessage.content.length / 4)
        : Math.ceil(userQuery.length / 4);
      const completionTokens = Math.ceil(simplifiqueData.data.answer.length / 4);
      const totalTokens = promptTokens + completionTokens;

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
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: totalTokens
        },
        metadata: {
          simplifique_chat_id: simplifiqueData.data.chat_id,
          service: 'simplifique.ai'
        }
      };

      res.json(openaiResponse);
    } catch (axiosError) {
      throw axiosError;
    }

  } catch (error) {
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

    res.status(500).json({
      error: {
        message: 'Internal server error',
        type: 'api_error',
        details: error.message
      }
    });
  }
});

// Health check
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

// Debug endpoint (opcional)
app.get('/debug/test', (req, res) => {
  res.json({
    message: 'Debug endpoint working',
    headers: req.headers,
    timestamp: new Date().toISOString()
  });
});

// List models (OpenAI compat)
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

// Start server
app.listen(PORT, () => {
  console.log(`Simplifique.ai OpenAI Proxy rodando na porta ${PORT}`);
  console.log(`Health check disponível em: http://localhost:${PORT}/health`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM recebido, encerrando servidor...');
  process.exit(0);
});

