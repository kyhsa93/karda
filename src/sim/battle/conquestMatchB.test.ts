import { describe } from 'vitest';
import { fullMatchCases } from './conquestMatch.cases';

describe('ticket causes over a full match, seeds 6-10 (#237)', () => fullMatchCases([6, 7, 8, 9, 10]));
