/**
 * Адрес клиента для ограничения попыток входа.
 *
 * Служба стоит за прокси, поэтому адрес сокета — это адрес прокси, один на всех:
 * десять неудачных входов откуда угодно запирали сразу все районы. Настоящий адрес
 * приходит в X-Forwarded-For, и прокси дописывает его в конец цепочки, поэтому берём
 * последний элемент: всё, что левее, клиент мог подставить сам.
 */
export function clientAddress(headers = {}, socketAddress = null) {
  const forwarded = headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    const chain = forwarded.split(',').map((part) => part.trim()).filter(Boolean);
    if (chain.length) return chain[chain.length - 1];
  }
  return socketAddress || 'unknown';
}
