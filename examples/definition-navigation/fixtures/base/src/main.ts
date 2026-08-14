import { DEFAULT_NAME } from './constants.ts';
import { formatGreeting } from './greeting.ts';

export const greeting = formatGreeting('World');
export const defaultGreeting = formatGreeting(DEFAULT_NAME);
