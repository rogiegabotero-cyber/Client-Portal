// src/data/dummyData.js

export const GRACE_MINUTES = 5
export const DEFAULT_SHIFT_HOURS = 8

// IMPORTANT: no dummy employees anymore.
// This prevents UI from showing fake data if API fails.
export function createInitialEmployees() {
  return []
}