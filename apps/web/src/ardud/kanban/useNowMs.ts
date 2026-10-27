import { useNowMinute } from "../../hooks/useNowMinute";

/** Minute-quantized epoch ms from the shared app clock (one module timer). */
export function useNowMs(): number {
  // useNowMinute is "YYYY-MM-DDTHH:MM" in UTC; without the zone suffix
  // Date.parse would read it as local time.
  return Date.parse(`${useNowMinute()}:00Z`);
}
