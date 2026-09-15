// Проверяет, дотягивается ли контейнер бота до Telegram.
const target = process.env.CHECK_URL || 'https://api.telegram.org';

try {
  const response = await fetch(target, { signal: AbortSignal.timeout(20000) });
  console.log('запрос прошёл, код', response.status);
} catch (error) {
  console.log('запрос не прошёл:', error.message, '| причина:', error.cause?.message || '—', '| код:', error.cause?.code || '—');
}

const dns = await import('node:dns/promises');
for (const host of ['api.telegram.org', 'example.com']) {
  try {
    const addresses = await dns.lookup(host, { all: true });
    console.log(`DNS ${host}:`, addresses.map((item) => item.address).join(', '));
  } catch (error) {
    console.log(`DNS ${host}: ошибка —`, error.message);
  }
}
