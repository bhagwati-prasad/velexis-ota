// @vitest-environment happy-dom
// The verification of submitted credentials, one component for the OTA's own Amadeus credentials (PFE-023) and its own
// Stripe keys (PFE-024) since FIX-W40-PLATFORM (lead decision (2h) of 2026-11-03): the words of each kind (moved here
// from amadeus.test.tsx and payments.test.tsx with the component), and the polling with a stand-in for the page's server
// action (every 2 seconds, one read at a time, a Retry-After, a read that may pass, one that stops, the portal out of
// reach, the end of the session, a final submission never read again). The pages' tests run the real actions against a
// mocked API through the same component.
import { act, cleanup, render, screen } from "@testing-library/react";
import { Component, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({
  // As Next.js's own does for a real redirect() or notFound(): throws them again, returns for anything else.
  unstable_rethrow: vi.fn((error: unknown): void => {
    if (error instanceof Error && /^NEXT_(REDIRECT|NOT_FOUND)/.test(error.message)) {
      throw error;
    }
  }),
}));
vi.mock("next/navigation", () => ({ unstable_rethrow: navigation.unstable_rethrow }));

import {
  isFinalSubmission,
  SUBMISSION_POLL_INTERVAL_MS,
  SubmissionStatus,
  submissionReason,
  type FollowedSubmission,
  type SubmissionPoll,
  type SubmissionPollResult,
  type SubmissionWording,
} from "@/components/submission-status";
import { STRIPE_KEYS_SUBMISSION_STRINGS, SUBMISSION_STRINGS } from "@/lib/strings";

const TENANT_ID = "ten_01JD4Q2S6V0X4Z8B2D6F0H4K8N";
const SUBMISSION_ID = "crs_01JD4Q2S6V0X4Z8B2D6F0H4K8N";
/** The words of the two kinds: own Amadeus credentials and own Stripe keys. */
const AMADEUS: SubmissionWording = SUBMISSION_STRINGS;
const STRIPE_KEYS: SubmissionWording = STRIPE_KEYS_SUBMISSION_STRINGS;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** A submission the component follows. */
function followed(overrides: Partial<FollowedSubmission> = {}): FollowedSubmission {
  return { id: SUBMISSION_ID, status: "pending", errorCode: null, ...overrides };
}

const ok = (submission: Partial<FollowedSubmission>): SubmissionPollResult => ({
  status: "ok",
  submission: followed(submission),
});

const refused = (message: string, transient: boolean, retryAfterSeconds?: number): SubmissionPollResult => ({
  status: "failed",
  code: transient ? "RATE_LIMITED" : "NOT_FOUND",
  message,
  transient,
  ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
});

/** A stand-in for the page's server action: the answers in turn (the last one again), each read counted. */
function pollOf(...answers: Array<() => Promise<SubmissionPollResult>>): SubmissionPoll & {
  readonly reads: Array<[string, string]>;
} {
  const reads: Array<[string, string]> = [];
  const poll = (tenantId: string, submissionId: string): Promise<SubmissionPollResult> => {
    reads.push([tenantId, submissionId]);
    const answer = answers[Math.min(reads.length, answers.length) - 1];
    return answer === undefined ? Promise.reject(new Error("no answer")) : answer();
  };
  return Object.assign(poll, { reads });
}

/** The polling runs on `setTimeout`, which these tests fake, so the 2 seconds pass only when a test says so. */
function fakePollTimers(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
}

/** Lets `ms` of fake time pass (and the timers due in it run), then lets the answers settle. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const block = (): HTMLElement | null => document.querySelector<HTMLElement>("[data-submission-status]");

/**
 * Next.js handles `redirect()` by navigating; here the error the component throws again while rendering reaches this
 * boundary, which shows where the browser would go.
 */
class RedirectBoundary extends Component<{ readonly children: ReactNode }, { readonly target?: string }> {
  override state: { readonly target?: string } = {};

  static getDerivedStateFromError(error: unknown): { target: string } {
    const match = error instanceof Error ? /^NEXT_REDIRECT (.+)$/.exec(error.message) : null;
    return { target: match?.[1] ?? `not a redirect: ${String(error)}` };
  }

  override render(): ReactNode {
    return this.state.target === undefined ? (
      this.props.children
    ) : (
      <p role="status">Redirected to {this.state.target}</p>
    );
  }
}

describe("the words of each kind", () => {
  it("[PFE-023 AC2] maps every verification result and apply refusal of own Amadeus credentials to plain words, never the code [PF-52 AC2]", () => {
    const codes = [
      "AMADEUS_CREDENTIALS_INVALID",
      "PROVIDER_UNAVAILABLE",
      "TENANT_NOT_ACTIVE",
      "CONNECTION_DISABLED",
      "FEATURE_DISABLED",
      "CONNECTION_CHANGED",
    ];
    const words = new Set<string>();
    for (const code of codes) {
      const reason = submissionReason(AMADEUS, code);
      expect(reason).toBe(AMADEUS.reasons[code]);
      expect(reason).not.toContain(code);
      words.add(reason);
    }
    // Each has words of its own; an unknown code or none gets the general words.
    expect(words.size).toBe(codes.length);
    expect(submissionReason(AMADEUS, "SOMETHING_NEWER")).toBe(AMADEUS.reasonUnknown);
    expect(submissionReason(AMADEUS, null)).toBe(AMADEUS.reasonUnknown);
    expect(submissionReason(AMADEUS, "__proto__")).toBe(AMADEUS.reasonUnknown);

    const poll = pollOf();
    for (const errorCode of [...codes, "SOMETHING_NEWER"]) {
      render(
        <SubmissionStatus
          tenantId={TENANT_ID}
          environment="live"
          submission={followed({ status: "failed", errorCode })}
          poll={poll}
          wording={AMADEUS}
        />,
      );
      expect(block()?.querySelector("[data-submission-reason]")?.textContent).toBe(
        submissionReason(AMADEUS, errorCode),
      );
      expect(block()?.textContent).not.toContain(errorCode);
      cleanup();
    }
    // A final submission is never read again.
    expect(poll.reads).toEqual([]);
  });

  it("[PFE-024 AC2] gives every verification result and apply refusal of own Stripe keys its own words, never the code [PF-62 AC1]", () => {
    for (const code of [
      "STRIPE_KEY_INVALID",
      "STRIPE_LIVEMODE_MISMATCH",
      "PROVIDER_UNAVAILABLE",
      "TENANT_NOT_ACTIVE",
      "CONNECTION_DISABLED",
      "CONNECTION_CHANGED",
      "FEATURE_DISABLED",
    ]) {
      const reason = submissionReason(STRIPE_KEYS, code);
      expect([code, reason === STRIPE_KEYS.reasonUnknown]).toEqual([code, false]);
      expect(reason).not.toContain(code);
    }
    expect(submissionReason(STRIPE_KEYS, "A_NEWER_CODE")).toBe(STRIPE_KEYS.reasonUnknown);
    expect(submissionReason(STRIPE_KEYS, null)).toBe(STRIPE_KEYS.reasonUnknown);
    expect(submissionReason(STRIPE_KEYS, "toString")).toBe(STRIPE_KEYS.reasonUnknown);
  });

  it("[FIX-W40-PLATFORM AC8] shows each kind in its own words: the title, the open text and the applied text of the environment", () => {
    for (const wording of [AMADEUS, STRIPE_KEYS]) {
      render(
        <SubmissionStatus
          tenantId={TENANT_ID}
          environment="test"
          submission={followed({ status: "applied" })}
          poll={pollOf()}
          wording={wording}
        />,
      );
      expect(block()?.textContent).toContain(wording.title);
      expect(screen.getByRole("status").textContent).toBe(wording.applied("test"));
      cleanup();
      render(
        <SubmissionStatus
          tenantId={TENANT_ID}
          environment="live"
          submission={followed({ status: "verifying" })}
          poll={pollOf(() => Promise.resolve(ok({ status: "verifying" })))}
          wording={wording}
        />,
      );
      expect(block()?.dataset["environment"]).toBe("live");
      expect(screen.getByRole("status").textContent).toBe(wording.open);
      cleanup();
    }
    expect(["applied", "failed", "superseded"].every(isFinalSubmission)).toBe(true);
    expect(["pending", "verifying"].some(isFinalSubmission)).toBe(false);
  });
});

describe("the polling", () => {
  it("[FIX-W40-PLATFORM AC8] reads every 2 seconds, one read at a time, until the submission is final, with the kind's read", async () => {
    fakePollTimers();
    const poll = pollOf(
      () => Promise.resolve(ok({ status: "verifying" })),
      () => Promise.resolve(ok({ status: "applied" })),
    );
    render(
      <SubmissionStatus
        tenantId={TENANT_ID}
        environment="test"
        submission={followed()}
        poll={poll}
        wording={STRIPE_KEYS}
      />,
    );
    expect(block()?.dataset["submissionStatus"]).toBe("pending");

    await advance(SUBMISSION_POLL_INTERVAL_MS - 1);
    expect(poll.reads).toEqual([]);
    await advance(1);
    expect(block()?.dataset["submissionStatus"]).toBe("verifying");
    await advance(SUBMISSION_POLL_INTERVAL_MS);
    expect(block()?.dataset["submissionStatus"]).toBe("applied");
    await advance(10 * SUBMISSION_POLL_INTERVAL_MS);

    expect(poll.reads).toEqual([
      [TENANT_ID, SUBMISSION_ID],
      [TENANT_ID, SUBMISSION_ID],
    ]);
    expect(screen.getByRole("status").textContent).toBe(STRIPE_KEYS.applied("test"));
  });

  it("[FIX-W40-PLATFORM AC8] keeps polling through a rate limit (after its Retry-After), an unavailable API and the portal out of reach, and stops with the portal's message", async () => {
    fakePollTimers();
    const poll = pollOf(
      () => Promise.resolve(refused("Too many requests.", true, 5)),
      () => Promise.reject(new Error("fetch failed")),
      () => Promise.resolve(ok({ status: "verifying" })),
      () => Promise.resolve(refused("The submission was not found.", false)),
    );
    render(
      <SubmissionStatus
        tenantId={TENANT_ID}
        environment="test"
        submission={followed()}
        poll={poll}
        wording={AMADEUS}
      />,
    );

    await advance(SUBMISSION_POLL_INTERVAL_MS);
    expect(block()?.querySelector("[data-poll-note]")?.textContent).toBe(AMADEUS.pollFailed);
    // The next read waits for the 5 seconds of Retry-After.
    await advance(4_999);
    expect(poll.reads).toHaveLength(1);
    await advance(1);
    expect(poll.reads).toHaveLength(2);
    expect(block()?.querySelector("[data-poll-note]")?.textContent).toBe(AMADEUS.pollFailed);
    await advance(SUBMISSION_POLL_INTERVAL_MS);
    expect(block()?.dataset["submissionStatus"]).toBe("verifying");
    expect(block()?.querySelector("[data-poll-note]")).toBeNull();
    await advance(SUBMISSION_POLL_INTERVAL_MS);
    expect(screen.getByRole("alert").textContent).toBe(
      `${AMADEUS.pollStoppedTitle}The submission was not found.`,
    );
    await advance(10 * SUBMISSION_POLL_INTERVAL_MS);
    expect(poll.reads).toHaveLength(4);
  });

  it("[FIX-W40-PLATFORM AC8] goes where the action's redirect() goes when the session ended, and reads no more", async () => {
    fakePollTimers();
    const poll = pollOf(() => Promise.reject(new Error("NEXT_REDIRECT /sign-in?next=%2Fotas")));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <RedirectBoundary>
        <SubmissionStatus
          tenantId={TENANT_ID}
          environment="test"
          submission={followed()}
          poll={poll}
          wording={STRIPE_KEYS}
        />
      </RedirectBoundary>,
    );

    await advance(SUBMISSION_POLL_INTERVAL_MS);

    expect(screen.getByRole("status").textContent).toBe("Redirected to /sign-in?next=%2Fotas");
    await advance(10 * SUBMISSION_POLL_INTERVAL_MS);
    expect(poll.reads).toHaveLength(1);
  });

  it("[FIX-W40-PLATFORM AC8] stops reading when it goes away, and a late answer changes nothing", async () => {
    fakePollTimers();
    let answer: (result: SubmissionPollResult) => void = () => undefined;
    const poll = pollOf(
      () =>
        new Promise<SubmissionPollResult>((resolve) => {
          answer = resolve;
        }),
    );
    const view = render(
      <SubmissionStatus
        tenantId={TENANT_ID}
        environment="test"
        submission={followed()}
        poll={poll}
        wording={AMADEUS}
      />,
    );
    await advance(SUBMISSION_POLL_INTERVAL_MS);
    view.unmount();

    await act(async () => {
      answer(ok({ status: "verifying" }));
      await Promise.resolve();
    });
    await advance(10 * SUBMISSION_POLL_INTERVAL_MS);

    expect(poll.reads).toHaveLength(1);
  });
});
