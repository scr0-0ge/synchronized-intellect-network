export interface Clock {
  now(): number;
}

export const systemClock: Clock = Object.freeze({
  now: (): number => Date.now(),
});
