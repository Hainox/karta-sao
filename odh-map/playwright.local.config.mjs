import base from './playwright.config.js';
export default { ...base, use: { browserName: 'chromium', headless: true } };
