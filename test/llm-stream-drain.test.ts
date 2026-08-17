/**
 * callOnce 의 스트림 소진 계약 (#542).
 *
 * SDK 0.1.9 는 for-await 중도 이탈 시 spawn 한 자식을 정리하지 않는다. 그래서 result 를
 * 받은 뒤에도 스트림을 소진해야 하는데, 무한 소진은 누수를 매달림으로 바꾼다. 두 실패
 * 모드를 함께 고정한다:
 *   1) result 후 닫히지 않는 스트림 → 상한 내에 결과를 들고 나온다 (매달리지 않는다)
 *   2) result 후 이터레이터가 던짐 → 확보한 결과를 버리지 않는다 (중복 과금·거짓 실패 방지)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const queryMock = vi.fn();

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));

function resultMessage(text: string) {
  return { type: 'result', result: text };
}

/** result 하나를 낸 뒤 영원히 멈추는 스트림. */
function neverClosingStream(text: string) {
  let sent = false;
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (!sent) {
            sent = true;
            return { done: false, value: resultMessage(text) };
          }
          return new Promise<never>(() => {}); // 영원히 미해결
        },
      };
    },
  };
}

/** result 하나를 낸 뒤 정리 단계에서 던지는 스트림. */
function throwsAfterResultStream(text: string) {
  let sent = false;
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (!sent) {
            sent = true;
            return { done: false, value: resultMessage(text) };
          }
          throw new Error('stream exploded during cleanup');
        },
      };
    },
  };
}

describe('callOnce 스트림 소진', () => {
  beforeEach(() => {
    queryMock.mockReset();
    process.env.MEMORY_BANK_LLM_DRAIN_MS = '50';
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.MEMORY_BANK_API_TOKEN;
  });

  afterEach(() => {
    delete process.env.MEMORY_BANK_LLM_DRAIN_MS;
  });

  it('result 후 닫히지 않아도 상한 내에 결과를 반환한다', async () => {
    queryMock.mockReturnValue(neverClosingStream('OK'));
    const { callHaiku } = await import('../src/llm.js');

    const started = Date.now();
    const out = await callHaiku('sys', 'msg', 64);
    const elapsed = Date.now() - started;

    expect(out).toBe('OK');
    // 상한(50ms)을 크게 넘지 않아야 한다 — 매달리면 테스트 타임아웃으로 죽는다
    expect(elapsed).toBeLessThan(5_000);
  }, 15_000);

  it('result 후 예외가 나도 확보한 결과를 버리지 않는다', async () => {
    queryMock.mockReturnValue(throwsAfterResultStream('KEEP-ME'));
    const { callHaiku } = await import('../src/llm.js');

    // API 키가 없으므로, 결과를 버리면 폴백 불가로 실패한다.
    // 결과를 지키면 그대로 반환된다.
    await expect(callHaiku('sys', 'msg', 64)).resolves.toBe('KEEP-ME');
  }, 15_000);
});
