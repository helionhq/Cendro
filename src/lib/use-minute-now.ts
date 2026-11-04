"use client";

import { useEffect, useState } from "react";

/**
 * A coarse `now` for time-derived Convex queries. Passing `Date.now()` on every
 * render would make every render a new query argument; rounding to the minute
 * keeps the subscription stable between ticks while still letting relative
 * labels and service status refresh without a reload.
 */
export function useMinuteNow() {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 60_000) * 60_000);

  useEffect(() => {
    function tick() {
      setNow((previous) => {
        const next = Math.floor(Date.now() / 60_000) * 60_000;
        return previous === next ? previous : next;
      });
    }
    tick();
    const interval = window.setInterval(tick, 30_000);
    return () => window.clearInterval(interval);
  }, []);

  return now;
}
