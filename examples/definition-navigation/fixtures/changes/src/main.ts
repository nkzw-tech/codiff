import { DEFAULT_NAME } from './constants.ts';
import { formatGreeting } from './greeting.ts';

export const greeting = formatGreeting('Codiff');
export const defaultGreeting = formatGreeting(DEFAULT_NAME);
