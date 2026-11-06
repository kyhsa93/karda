import { describe } from 'vitest';
import { fullMatchCases } from './conquestMatch.cases';

describe('ticket causes over a full match, seeds 1-5 (#237)', () => fullMatchCases([1, 2, 3, 4, 5]));
