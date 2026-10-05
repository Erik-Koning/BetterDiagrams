/**
 * today.ts — the local date as React state, turning over at midnight.
 *
 * Overdue is measured against today, and an editor left open overnight has to
 * notice the date move without an edit to prompt it: a timer for the next
 * local midnight, and a look whenever the tab is shown again (a sleeping
 * laptop's timer can wake late). Setting the same string again is a no-op, so
 * the look costs nothing on an ordinary day.
 */
import { useEffect, useState } from "react";
import { todayIso } from "../contract/tasks";

export function useToday(): string {
  const [today, setToday] = useState(todayIso);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => setToday(todayIso());
    const arm = () => {
      const now = new Date();
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      timer = setTimeout(() => {
        check();
        arm();
      }, midnight.getTime() - now.getTime() + 1000);
    };
    const onShow = () => {
      if (!document.hidden) check();
    };
    arm();
    document.addEventListener("visibilitychange", onShow);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onShow);
    };
  }, []);
  return today;
}
