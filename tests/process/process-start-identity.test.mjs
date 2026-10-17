import { afterEach, describe, expect, it } from 'vitest';
import {
  checkProcessIdentity,
  setProcessStartReaderForTests
} from '../../src/process/process-start.mjs';

describe('checkProcessIdentity', () => {
  const lockWrittenAt = '2026-10-16T12:00:00.000Z';
  const lockTime = new Date(lockWrittenAt).getTime();

  afterEach(() => setProcessStartReaderForTests(null));

  it('различает подтверждённое совпадение', () => {
    setProcessStartReaderForTests(() => new Date(lockTime - 1000));
    expect(checkProcessIdentity(123, lockWrittenAt, { fresh: true })).toEqual({ status: 'MATCH' });
  });

  it('различает переиспользованный pid', () => {
    setProcessStartReaderForTests(() => new Date(lockTime + 10_000));
    expect(checkProcessIdentity(123, lockWrittenAt, { fresh: true })).toEqual({ status: 'PID_REUSED' });
  });

  it('не выдаёт неизвестное время старта за совпадение', () => {
    setProcessStartReaderForTests(() => null);
    expect(checkProcessIdentity(123, lockWrittenAt, { fresh: true })).toEqual({ status: 'IDENTITY_UNKNOWN' });
  });

  it('ошибка опроса и непригодный ответ означают неизвестную идентичность', () => {
    setProcessStartReaderForTests(() => { throw new Error('query failed'); });
    expect(checkProcessIdentity(123, lockWrittenAt, { fresh: true })).toEqual({ status: 'IDENTITY_UNKNOWN' });

    setProcessStartReaderForTests(() => new Date(Number.NaN));
    expect(checkProcessIdentity(123, lockWrittenAt, { fresh: true })).toEqual({ status: 'IDENTITY_UNKNOWN' });
  });

  it('без времени записи lock идентичность неизвестна', () => {
    setProcessStartReaderForTests(() => new Date(lockTime - 1000));
    expect(checkProcessIdentity(123, null, { fresh: true })).toEqual({ status: 'IDENTITY_UNKNOWN' });
  });
});
