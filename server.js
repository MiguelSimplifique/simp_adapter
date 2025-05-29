const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

const app = express();
const SIMPLIFIQUE_BASE_URL = 'https://app.simplifique.ai/pt/chatbot/api/v1';
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.originalUrl}`);
  next();
});

// --- FunctionCall Parser ---
function parseFunctionCall(answer) {
  if (!answer) return { content: '', tool_calls: null };

  // Exemplo de padrão: [FUNCTION_CALL]\nnome_funcao\n{...}
  const funcRegex = /^\[FUNCTION_CALL\]\s*([\w\d_]+)\s*([\s\S]+)$/m;
  const match = answer.match(funcRegex);

  if (match) {
    const name = match[1];
    let args = match[2].trim();

    // Valida e corrige o JSON dos argumentos (tenta evitar erros)
    try {
      // Limpa possíveis comentários ou textos extras
      if (args.startsWith('{') && args.endsWith('}')) {
        JSON.parse(args); // Validação rápida, pode lançar erro!
      }
    } catch (err) {
      // Argumentos inválidos - retorna como texto normal
      return { content: answer, tool_calls: null };
    }

    // Monta o padrão OpenAI tools
    return {
      content: '', // Não mostra texto ao usuário, só a tool_call
      tool_calls: [
        {
          id: `tool1`,
          type: "function",
          function: {
            name,
            arguments: args
          }
        }
      ]
    };
  }

  // Se não for function_call, só retorna o texto
  return { content: answer, tool_calls: null };
}

// --- MAIN ENDPOINT ---
app.post('/v1/chat/completions', async (req, res) => {
  let openaiRequest = req.body;
  let chatbotUuid = '';
  let apiToken = '';
  let userQuery = '';
  let userKey = '';
  let customSystemPrompt = '';
  let lastMessage = null;
  let simplifiqueData = undefined;
  let promptTokens = 0, completionTokens = 0, totalTokens = 0;

  try {
    // --- Autenticação ---
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new Error('Authorization header missing or invalid');
    }
    const authData = authHeader.replace('Bearer ', '').trim();
    [apiToken, chatbotUuid] = authData.split(':');
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(chatbotUuid)) {
      throw new Error('Invalid chatbot UUID format');
    }

    // --- Parse messages ---
    let messages = openaiRequest.messages || [];
    if (messages.length === 1 && typeof messages[0] === 'string') {
      // Formato string/n8n
      const messageString = messages[0];
      const systemMatch = messageString.match(/System:\s*([\s\S]*?)(?=Contexto Extra|$)/);
      if (systemMatch) customSystemPrompt = systemMatch[1].trim();
      const contextoMatch = messageString.match(/Contexto Extra\s*Human:\s*([\s\S]*?)$/);
      if (contextoMatch) {
        const contextoContent = contextoMatch[1].trim();
        const queryMatch = contextoContent.match(/Query:\s*([\s\S]*?)\s*user_key:/i);
        if (queryMatch) userQuery = queryMatch[1].trim();
        const userKeyMatch = contextoContent.match(/user_key:\s*([^\n\r]*)/i);
        if (userKeyMatch) userKey = userKeyMatch[1].trim();
      }
      if (!userQuery) {
        const humanMatch = messageString.match(/Human:\s*([^\n\r]*)/);
        if (humanMatch) userQuery = humanMatch[1].trim();
      }
      if (userQuery) lastMessage = { role: 'user', content: userQuery };
    } else if (Array.isArray(messages)) {
      // Formato OpenAI array
      const systemMessage = messages.find(
        m => typeof m === 'object' && m.role === 'system' && m.content
      );
      if (systemMessage) customSystemPrompt = systemMessage.content.trim();
      const validMessages = messages.filter(m => typeof m === 'object' && m.content);
      lastMessage = validMessages.length > 0 ? validMessages[validMessages.length - 1] : null;
      if (lastMessage && lastMessage.content) userQuery = lastMessage.content.trim();
    }

    if (!userQuery) {
      throw new Error('No user message found');
    }

    // --- User Key ---
    const KNOWN_MODELS = ['gpt-3.5-turbo', 'gpt-4', 'gpt-4o', 'simplifique-default'];
    if (!userKey) {
      if (openaiRequest.model && !KNOWN_MODELS.includes(openaiRequest.model)) {
        userKey = openaiRequest.model;
      } else {
        userKey = openaiRequest.user ||
                  req.headers['x-user-key'] ||
                  req.headers['x-user-id'] ||
                  `n8n-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      }
    }

    // --- Payload para Simplifique ---
    const simplifiqueRequest = {
      chatbot_uuid: chatbotUuid,
      query: userQuery,
      user_key: userKey
    };
    if (customSystemPrompt && customSystemPrompt.trim()) {
      simplifiqueRequest.custom_base_system_prompt = customSystemPrompt;
    }

    // --- Chama Simplifique ---
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
      simplifiqueData = simplifiqueResponse.data;
    } catch (err) {
      simplifiqueData = {
        data: {
          answer: 'Desculpe, não foi possível obter uma resposta do chatbot agora.',
          chat_id: null
        }
      };
      console.error('\n=== Erro ao chamar Simplifique.ai ===');
      console.error(err.response?.data || err.message);
    }

    // --- Parse Function Call ---
    const { content, tool_calls } = parseFunctionCall(
      simplifiqueData?.data?.answer || ""
    );

    // --- Tokens (estimativa segura) ---
    promptTokens = lastMessage?.content
      ? Math.ceil(lastMessage.content.length / 4)
      : Math.ceil(userQuery.length / 4);
    completionTokens = content
      ? Math.ceil(String(content).length / 4)
      : Math.ceil((simplifiqueData?.data?.answer || "").length / 4);
    totalTokens = promptTokens + completionTokens;

    // --- Response OpenAI format ---
    const openaiResponse = {
      id: `chatcmpl-${uuidv4()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: openaiRequest?.model || 'gpt-3.5-turbo',
      system_fingerprint: `simplifique_${chatbotUuid}`,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: content,
          tool_calls: tool_calls // null, ou array se houver function call
        },
        logprobs: null,
        finish_reason: 'stop'
      }],
      usage: {
        prompt_tokens: promptTokens || 0,
        completion_tokens: completionTokens || 0,
        total_tokens: totalTokens || 0
      },
      metadata: {
        simplifique_chat_id: (simplifiqueData && simplifiqueData.data && simplifiqueData.data.chat_id) || null,
        service: 'simplifique.ai'
      }
    };

    res.json(openaiResponse);

  } catch (error) {
    // Resposta de erro sempre no formato OpenAI
    res.status(500).json({
      id: `chatcmpl-${uuidv4()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: openaiRequest?.model || 'gpt-3.5-turbo',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: `Desculpe, ocorreu um erro: ${error.message || 'erro inesperado.'}`,
          tool_calls: null
        },
        finish_reason: 'stop'
      }],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0
      },
      metadata: {
        simplifique_chat_id: null,
        service: 'simplifique.ai'
      }
    });
  }
});

// --- Healthcheck e outros endpoints ---
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

app.listen(PORT, () => {
  console.log(`Simplifique.ai OpenAI Proxy rodando na porta ${PORT}`);
  console.log(`Health check disponível em: http://localhost:${PORT}/health`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM recebido, encerrando servidor...');
  process.exit(0);
});



