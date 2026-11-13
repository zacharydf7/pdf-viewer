import { expect, it, vi } from "vitest";
import { UseCounter } from "../../src/use-counter.js";

it("release_ShouldCleanUp_WhenOnlyUserLetsGo", () => {
  const cleanup = vi.fn();
  const release = new UseCounter<number>().acquire(1, cleanup);

  release();

  expect(cleanup).toHaveBeenCalledOnce();
});

it("release_ShouldWaitForLastUser_WhenSeveralShareSameKey", () => {
  const counter = new UseCounter<number>();
  const cleanup = vi.fn();
  const first = counter.acquire(1, cleanup);
  const second = counter.acquire(1, cleanup);

  first();
  expect(cleanup).not.toHaveBeenCalled();
  second();

  expect(cleanup).toHaveBeenCalledOnce();
});

it("release_ShouldCountOnce_WhenSameUserLetsGoTwice", () => {
  const counter = new UseCounter<number>();
  const cleanup = vi.fn();
  const first = counter.acquire(1, cleanup);
  counter.acquire(1, cleanup);

  first();
  first();

  expect(cleanup).not.toHaveBeenCalled();
});

it("release_ShouldNotAffectOtherKeys_WhenKeysDiffer", () => {
  const counter = new UseCounter<number>();
  const cleanupOne = vi.fn();
  const cleanupTwo = vi.fn();
  const releaseOne = counter.acquire(1, cleanupOne);
  counter.acquire(2, cleanupTwo);

  releaseOne();

  expect(cleanupOne).toHaveBeenCalledOnce();
  expect(cleanupTwo).not.toHaveBeenCalled();
});

it("acquire_ShouldStartNewCount_WhenKeyWasFullyReleasedBefore", () => {
  const counter = new UseCounter<number>();
  const cleanup = vi.fn();
  counter.acquire(1, cleanup)();

  counter.acquire(1, cleanup)();

  expect(cleanup).toHaveBeenCalledTimes(2);
});
