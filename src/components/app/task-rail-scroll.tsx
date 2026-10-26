"use client";

import React, { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "../../lib/utils";

export type TaskRailScrollOptions = {
  railRef: RefObject<HTMLElement | null>;
  activeCompanyId?: string | null;
  canUseAllTasks: boolean;
  effectiveTaskView: "all" | "my" | "custom" | "awaiting";
};

export function syncToggleScrollState(node: HTMLElement | null) {
  if (!node) return;
  const maxScroll = node.scrollWidth - node.clientWidth;
  const start = node.scrollLeft > 2 ? "true" : "false";
  const end = maxScroll > 2 && node.scrollLeft < maxScroll - 2 ? "true" : "false";
  node.dataset.scrollStart = start;
  node.dataset.scrollEnd = end;
  const parent = node.parentElement;
  if (parent && parent.classList.contains("task-rail-wrapper")) {
    parent.dataset.scrollStart = start;
    parent.dataset.scrollEnd = end;
  }
}

export function scrollActivePillIntoView(rail: HTMLElement | null, behavior: ScrollBehavior = "smooth") {
  const pill = rail?.querySelector<HTMLElement>('[data-active="true"]');
  if (!rail || !pill) return;
  const railRect = rail.getBoundingClientRect();
  const pillRect = pill.getBoundingClientRect();
  const edgePadding = 36;

  if (pillRect.left < railRect.left + edgePadding) {
    const diff = railRect.left + edgePadding - pillRect.left;
    const target = Math.max(0, rail.scrollLeft - diff);
    if (typeof rail.scrollTo === "function") {
      rail.scrollTo({ left: target, behavior });
    } else {
      rail.scrollLeft = target;
    }
  } else if (pillRect.right > railRect.right - edgePadding) {
    const diff = pillRect.right - (railRect.right - edgePadding);
    const maxScroll = rail.scrollWidth - rail.clientWidth;
    const target = Math.min(maxScroll, rail.scrollLeft + diff);
    if (typeof rail.scrollTo === "function") {
      rail.scrollTo({ left: target, behavior });
    } else {
      rail.scrollLeft = target;
    }
  }
}

export function scrollRail(rail: HTMLElement | null, direction: "left" | "right") {
  if (!rail) return;
  const step = Math.max(160, Math.min(240, Math.round(rail.clientWidth * 0.6)));
  const delta = direction === "left" ? -step : step;
  if (typeof rail.scrollBy === "function") {
    rail.scrollBy({ left: delta, behavior: "smooth" });
  } else {
    rail.scrollLeft += delta;
  }
}

export function useTaskRailAutoScroll({
  railRef,
  activeCompanyId,
  canUseAllTasks,
  effectiveTaskView,
}: TaskRailScrollOptions) {
  const [scrollState, setScrollState] = useState({ canStart: false, canEnd: false });
  const isInitialMount = useRef(true);

  const syncState = useCallback(() => {
    const node = railRef.current;
    if (!node) return;
    syncToggleScrollState(node);
    const maxScroll = node.scrollWidth - node.clientWidth;
    const canStart = node.scrollLeft > 2;
    const canEnd = maxScroll > 2 && node.scrollLeft < maxScroll - 2;
    setScrollState((prev) => (prev.canStart === canStart && prev.canEnd === canEnd ? prev : { canStart, canEnd }));
  }, [railRef]);

  const scrollActive = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      scrollActivePillIntoView(railRef.current, behavior);
    },
    [railRef]
  );

  const handleScrollRail = useCallback(
    (direction: "left" | "right") => {
      scrollRail(railRef.current, direction);
    },
    [railRef]
  );

  // Observers for layout and child updates
  useEffect(() => {
    const node = railRef.current;
    if (!node) return;

    let resizeObserver: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => {
        syncState();
      });
      resizeObserver.observe(node);
    }

    let mutationObserver: MutationObserver | undefined;
    if (typeof MutationObserver !== "undefined") {
      mutationObserver = new MutationObserver(() => {
        syncState();
      });
      mutationObserver.observe(node, { childList: true, subtree: true });
    }

    const onResize = () => {
      syncState();
    };
    window.addEventListener("resize", onResize);

    return () => {
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      window.removeEventListener("resize", onResize);
    };
  }, [syncState, railRef]);

  // Initial mount / company change
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      scrollActive("instant");
    } else {
      scrollActive("instant");
    }
    syncState();
  }, [activeCompanyId, scrollActive, syncState]);

  // View state change (user clicks a view tab) -> always smooth scroll into view
  useEffect(() => {
    if (!isInitialMount.current) {
      scrollActive("smooth");
      syncState();
    }
  }, [effectiveTaskView, canUseAllTasks, scrollActive, syncState]);

  // Wheel listener
  useEffect(() => {
    const node = railRef.current;
    if (!node) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.deltaY === 0) return;
      const maxScroll = node.scrollWidth - node.clientWidth;
      if (maxScroll <= 2) return;
      const canScrollRight = e.deltaY > 0 && node.scrollLeft < maxScroll - 2;
      const canScrollLeft = e.deltaY < 0 && node.scrollLeft > 2;
      if (canScrollRight || canScrollLeft) {
        e.preventDefault();
        node.scrollLeft += e.deltaY;
        syncToggleScrollState(node);
      }
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [railRef]);

  return {
    syncToggleScrollState: syncState,
    scrollActivePillIntoView: scrollActive,
    canScrollStart: scrollState.canStart,
    canScrollEnd: scrollState.canEnd,
    scrollRail: handleScrollRail,
  };
}

export function TaskRail({
  railRef,
  children,
  onScroll,
  ariaLabel = "Task view",
  className,
}: {
  railRef: RefObject<HTMLElement | null>;
  children: React.ReactNode;
  onScroll?: () => void;
  ariaLabel?: string;
  className?: string;
}) {
  const handleScrollLeft = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    scrollRail(railRef.current, "left");
  };

  const handleScrollRight = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    scrollRail(railRef.current, "right");
  };

  const handleScroll = () => {
    syncToggleScrollState(railRef.current);
    onScroll?.();
  };

  return (
    <div className="task-rail-wrapper group relative min-w-0 flex-1 flex items-center">
      <button
        type="button"
        className="task-rail-arrow task-rail-arrow-left"
        onClick={handleScrollLeft}
        aria-label="Scroll left"
        tabIndex={-1}
      >
        <ChevronLeft className="h-4 w-4" />
      </button>
      <div
        ref={railRef as any}
        className={cn("task-view-toggle min-w-0 flex-1", className)}
        aria-label={ariaLabel}
        onScroll={handleScroll}
      >
        {children}
      </div>
      <button
        type="button"
        className="task-rail-arrow task-rail-arrow-right"
        onClick={handleScrollRight}
        aria-label="Scroll right"
        tabIndex={-1}
      >
        <ChevronRight className="h-4 w-4" />
      </button>
    </div>
  );
}
