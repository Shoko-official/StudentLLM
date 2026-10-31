import { describe, expect, it } from 'vitest';
import { AI_TIMEOUT_MESSAGE, AI_UNREACHABLE_MESSAGE, describeAiFailure, describeDocumentFailure, describeServiceUnreachable, describeSpeechFailure, isNetworkFailure } from './service-errors';

describe('service error messages', () => {
  it('explains an unreachable model without the HTTP status', () => {
    expect(describeAiFailure(new Error('Provider request failed (502)'))).toBe(AI_UNREACHABLE_MESSAGE);
    expect(describeAiFailure(new Error('Provider request failed (503)'))).toBe(AI_UNREACHABLE_MESSAGE);
    expect(describeAiFailure(new TypeError('Failed to fetch'))).toBe(AI_UNREACHABLE_MESSAGE);
    expect(describeAiFailure(new TypeError('Load failed'))).toBe(AI_UNREACHABLE_MESSAGE);
    expect(AI_UNREACHABLE_MESSAGE).not.toMatch(/\b50\d\b|fetch/i);
  });

  it('keeps the detail of a model that answered with an error', () => {
    expect(describeAiFailure(new Error('Provider request failed (500): Context length exceeded'))).toBe('Provider request failed (500): Context length exceeded');
    expect(describeAiFailure(new Error('Provider request failed (400): model not found'))).toContain('model not found');
    expect(describeAiFailure(new Error('Provider request failed (404)'))).toContain('HTTP 404');
  });

  it('explains timeouts and keeps unrelated messages', () => {
    expect(describeAiFailure(new Error('Provider request timed out.'))).toBe(AI_TIMEOUT_MESSAGE);
    expect(describeAiFailure(new Error('The model returned no final answer. Try again or choose another model in Settings.'))).toContain('no final answer');
    expect(describeAiFailure('boom', 'Fallback.')).toBe('Fallback.');
    expect(describeAiFailure(new TypeError('Cannot read properties of undefined'))).toBe('Cannot read properties of undefined');
  });

  it('describes a speech or document service that is not running', () => {
    expect(describeServiceUnreachable(new TypeError('Failed to fetch'))).toMatch(/^Not running/);
    expect(describeServiceUnreachable(new DOMException('Aborted', 'AbortError'))).toMatch(/timed out/);
    expect(describeServiceUnreachable(new Error('Something else'))).toBe('Something else');
    expect(isNetworkFailure(new Error('NetworkError when attempting to fetch resource.'))).toBe(true);
  });

  it('tells a damaged or protected document apart from a service that is not running', () => {
    const rejected = describeDocumentFailure(new Error('Local document extraction failed (422): Document extraction failed.'));
    expect(rejected).toMatch(/damaged or protected by a password/);
    expect(rejected).not.toMatch(/Start it|refresh/);
    expect(describeDocumentFailure(new TypeError('Failed to fetch'))).toMatch(/offline\. Start it/);
    expect(describeDocumentFailure(new Error('Local document extraction timed out.'))).toMatch(/document service is offline or took too long/);
    expect(describeDocumentFailure(new Error('The document is too large.'))).toBe('The document is too large.');
    expect(describeDocumentFailure(new Error('Local document extraction failed (500): boom'))).toMatch(/refresh the local services/);
  });

  it('keeps the audio reassurance in speech failures', () => {
    expect(describeSpeechFailure(new TypeError('Failed to fetch'))).toMatch(/audio was kept/);
    expect(describeSpeechFailure(new Error('Local transcription timed out.'))).toMatch(/too long/);
    expect(describeSpeechFailure(new Error('No speech was detected in this recording.'))).toBe('No speech was detected in this recording.');
  });
});
