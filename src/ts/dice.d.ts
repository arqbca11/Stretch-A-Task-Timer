// Types for src/js/dice.js, which stays JavaScript: it's ported verbatim from the Roll app.

// Roll the die at (x, y) in the lane, y being the table it bounces on; done(n) once it has
// landed and vanished (right away with reduced motion). Does nothing if a roll is going.
export function rollDie(laneEl: HTMLElement, x: number, y: number, n: number, done: (n: number) => void): void;
export function cancelRoll(): void;
export function dieBusy(): boolean;
