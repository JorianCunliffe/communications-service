import test from 'node:test';
import assert from 'node:assert/strict';
import { outlookMessage } from '../outlookMailbox.js';

test('Outlook message selects file attachment contentId with its derived type', async () => {
  const email = await outlookMessage('test-token', 'message-1', 'owner@example.com', {
    request: async (_token, path) => {
      const expand = new URL(path, 'https://graph.microsoft.com/v1.0/').searchParams.get('$expand');
      const fields = expand.slice(expand.indexOf('=') + 1, -1).split(',');
      const base = new Set(['id', 'name', 'contentType', 'size', 'isInline']);
      assert.ok(fields.every(field => base.has(field) || field === 'microsoft.graph.fileAttachment/contentId'));
      assert.ok(fields.includes('microsoft.graph.fileAttachment/contentId'));
      return { id: 'message-1', from: {emailAddress: {address: 'sender@example.com'}}, toRecipients: [{emailAddress: {address: 'owner@example.com'}}], body: {contentType: 'text', content: 'Test'}, attachments: [{id: 'file-1', name: 'logo.png', contentType: 'image/png', size: 12, isInline: true, contentId: 'inline-logo'}] };
    }
  });
  assert.equal(email.attachments[0].content_id, 'inline-logo');
});
