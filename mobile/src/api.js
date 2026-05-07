// Update this URL after deploying to Render
const BASE_URL = process.env.EXPO_PUBLIC_API_URL || 'https://cleetus.onrender.com';

async function req(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export const api = {
  // Conversations
  listConversations: () => req('/api/conversations'),
  getConversation:   (id) => req(`/api/conversations/${id}`),
  createConversation: (title = 'New conversation') =>
    req('/api/conversations', { method: 'POST', body: JSON.stringify({ title }) }),
  updateTitle: (id, title) =>
    req(`/api/conversations/${id}/title`, { method: 'PATCH', body: JSON.stringify({ title }) }),
  getMessages: (id) => req(`/api/conversations/${id}/messages`),

  // Chat streaming — calls onChunk(text), onDone(), onError(msg)
  streamChat(convId, message, { onChunk, onDone, onError }) {
    const controller = new AbortController();
    fetch(`${BASE_URL}/api/conversations/${convId}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
      signal: controller.signal,
    }).then(async (res) => {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (!raw) continue;
          try {
            const evt = JSON.parse(raw);
            if (evt.type === 'chunk') onChunk(evt.text);
            else if (evt.type === 'done') onDone();
            else if (evt.type === 'error') onError(evt.message);
          } catch {}
        }
      }
    }).catch((err) => {
      if (err.name !== 'AbortError') onError(err.message);
    });
    return controller; // call controller.abort() to cancel
  },

  // Memory
  listMemories:   () => req('/api/memories'),
  searchMemories: (q) => req(`/api/memories/search?q=${encodeURIComponent(q)}`),
  memoryCount:    () => req('/api/memories/count'),
  deleteMemory:   (id) => req(`/api/memories/${id}`, { method: 'DELETE' }),

  // SMS
  smsStatus:  () => req('/api/sms/status'),
  smsSync:    () => req('/api/sms/sync', { method: 'POST' }),
  smsMessages:(limit = 30) => req(`/api/sms/messages?limit=${limit}`),
  smsSend:    (to, message) =>
    req('/api/sms/send', { method: 'POST', body: JSON.stringify({ to, message }) }),
};
