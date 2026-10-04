import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { draftRecipientListsMatch } from '../draftRecipientComparison.js';

describe('draft recipient list comparison', () => {
    test('matches bare addresses and named addresses independent of display name', () => {
        assert.equal(
            draftRecipientListsMatch(
                ['Jorian Cunliffe <address@example.com>'],
                ['Different Name <ADDRESS@example.com>'],
            ),
            true,
        );
        assert.equal(draftRecipientListsMatch(['address@example.com'], ['Jorian Cunliffe <address@example.com>']), true);
    });

    test('matches quoted display names and ignores list order', () => {
        assert.equal(
            draftRecipientListsMatch(
                ['"Cunliffe, Jorian" <jorian@example.com>', 'other@example.com'],
                ['OTHER@example.com', '"Jorian" <JORIAN@example.com>'],
            ),
            true,
        );
    });

    test('accepts common dot-atom local parts', () => {
        assert.equal(
            draftRecipientListsMatch(
                ["Jorian <jorian.cunliffe+mail-test.o'connor@example-domain.com>"],
                ["Different Name <JORIAN.CUNLIFFE+MAIL-TEST.O'CONNOR@EXAMPLE-DOMAIN.COM>"],
            ),
            true,
        );
    });

    test('does not match different addresses, duplicates, or added and removed recipients', () => {
        assert.equal(draftRecipientListsMatch(['one@example.com'], ['two@example.com']), false);
        assert.equal(draftRecipientListsMatch(['one@example.com', 'one@example.com'], ['one@example.com']), false);
        assert.equal(draftRecipientListsMatch(['one@example.com'], ['one@example.com', 'two@example.com']), false);
        assert.equal(draftRecipientListsMatch(['one@example.com', 'two@example.com'], ['one@example.com']), false);
    });

    test('supports empty recipient lists', () => {
        assert.equal(draftRecipientListsMatch([], []), true);
        assert.equal(draftRecipientListsMatch([], ['one@example.com']), false);
    });

    test('rejects malformed, non-array, multiple-recipient, and header-injected inputs', () => {
        const invalidLists = [
            null,
            'one@example.com',
            [null],
            [42],
            ['not-an-email'],
            ['one@example.com, two@example.com'],
            ['one@example.com; two@example.com'],
            ['Name <one@example.com>, Other <two@example.com>'],
            ['Name <one@example.com> trailing@example.com'],
            ['prefix <one@example.com> <two@example.com>'],
            ['Name <one@example.com>\r\nBcc: other@example.com'],
            ['"Name, With Comma" <bad,local@example.com>'],
            ['"Name; With Semicolon" <bad;local@example.com>'],
            ['"Name" <bad"local@example.com>'],
            ['"Name" <bad..local@example.com>'],
            ['"Name" <local@bad..example.com>'],
            ['"Name" <local@-bad.example.com>'],
            ['"Name" <local@bad-.example.com>'],
        ];

        for (const invalid of invalidLists) {
            assert.equal(draftRecipientListsMatch(invalid, invalid), false, `expected invalid input to fail: ${String(invalid)}`);
            assert.equal(draftRecipientListsMatch([], invalid), false, `expected invalid input to fail: ${String(invalid)}`);
        }
    });
});