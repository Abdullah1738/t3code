"""Fake credentials only; this corpus is also run against the fork copy."""
import importlib.util
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SOURCE = HERE / 'redact.py' if (HERE / 'redact.py').exists() else HERE.parent / 'redact.py'
spec = importlib.util.spec_from_file_location('credential_redactor', SOURCE)
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)

CASES = [
    ('Browser Stack Email - qa.user@example.com pass - Fake#Pass123', 'Fake#Pass123'),
    ('pass: Fake#Pass123', 'Fake#Pass123'), ('pass - Fake#Pass123', 'Fake#Pass123'),
    ('Pass – Fake#Pass123', 'Fake#Pass123'), ('pwd Fake#Pass123', 'Fake#Pass123'),
    ('PW: Fake#Pass123', 'Fake#Pass123'), ('password -> "fake pass 99"', 'fake pass 99'),
    ('password\nFake#Pass123', 'Fake#Pass123'),
    ('login details:\nqa@example.com\nFake#Pass123', 'Fake#Pass123'),
    ('creds: admin / Fake#Pass123', 'Fake#Pass123'), ('otp – 482913', '482913'),
    ('token - abcDEF123456', 'abcDEF123456'),
    ('password reset-Fake99!', 'reset-Fake99!'), ('client secret = Zz9fake', 'Zz9fake'),
]
CASES += [('qa@example.com' + sep + quote + 'FakePassword https://example.test/path FakeTail99' + quote, 'FakeTail99')
          for quote in ['"', "'", '`'] for sep in [' / ', ', ', ' | ', '\n']]

UNCHANGED = [
    'pass the ball', "I'll pass on that", 'pin the message', 'code review tomorrow',
    'token budget is low', 'password reset link sent', 'https://example.com/reset?pass=1',
    'cb7213c4-b86c-4ac8-a52c-f6dc4b778ab1', 'CRP-1234',
    'password rotation is due', 'seed data for dev', 'token issue tomorrow',
    'pass on, please', 'passwords are private', 'password is wrong',
    '/var/folders/fixtureAbc1234567890Abc1234567890/batch.json',
    'reply-02-wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww',
    'fixture-super-secret-value', '[secret removed]', '[card number removed]', '[redacted token]',
]
LABELS = ['password', 'passwd', 'passcode', 'passphrase', 'pass', 'pwd', 'pw', 'pin',
          'otp', '2fa', 'mfa', 'code', 'token', 'secret', 'api key', 'api_key', 'api-key',
          'access key', 'access_key', 'access-key', 'private key', 'private_key', 'private-key',
          'client secret', 'client_secret', 'client-secret', 'seed', 'mnemonic',
          'recovery phrase', 'recovery_phrase', 'recovery-phrase']
SEPARATORS = [': ', ' = ', ' - ', ' – ', ' — ', ' => ', ' -> ', ' is ', '\n', ':\n', '\r\n', ':\r\n', '\t', ' \n\t']


class RedactTests(unittest.TestCase):
    def test_incident_and_requested_forms(self):
        for text, value in CASES:
            with self.subTest(text=text):
                result = r.redact(text)
                self.assertNotIn(value, result)
                self.assertIn('[redacted]', result)
                self.assertEqual(r.redact(result), result)
        self.assertIn('Browser Stack', r.redact(CASES[0][0]))

    def test_label_separator_quote_matrix(self):
        for label in LABELS:
            for sep in SEPARATORS:
                for value in ['Fake#Pass123', '"fake pass 99"', "'fake pass 99'", '`fake pass 99`']:
                    with self.subTest(label=label, sep=sep, value=value):
                        self.assertEqual(r.redact(label + sep + value), label + sep + '[redacted]')

    def test_plain_values_and_prose(self):
        for text in UNCHANGED:
            with self.subTest(text=text):
                self.assertEqual(r.redact(text), text)
        for label in LABELS:
            self.assertEqual(r.redact(label + ' Fake#Pass123'), label + ' [redacted]')
        self.assertEqual(r.redact('password alphanumeric'), 'password [redacted]')
        self.assertEqual(r.redact('code password: Fake#Pass123'), 'code password: [redacted]')

    def test_block_shapes(self):
        for header in ['login details', 'credentials', 'creds']:
            for user in ['admin', 'qa@example.com', 'username: admin', 'email: qa@example.com']:
                for sep in [' / ', '\n', ' : ', ' - ', ' => ', '\n\t', '\r\n']:
                    for gap in ['', '\n', '\n\n']:
                        text = header + ':' + gap + user + sep + '"fake pass 99"'
                        with self.subTest(text=text):
                            result = r.redact(text)
                            self.assertNotIn('fake pass 99', result)
                            self.assertIn(user, result)
                            self.assertEqual(r.redact(result), result)

    def test_labelled_values_inside_credential_blocks(self):
        for header in ['login details', 'credentials', 'creds']:
            for user in ['admin', 'qa@example.com', 'username: admin', 'email: qa@example.com']:
                for label in LABELS:
                    for sep in [': ', ' - ', '\n']:
                        text = header + ':\n' + user + '\n' + label + sep + 'Fake#Pass123'
                        with self.subTest(header=header, user=user, label=label, sep=sep):
                            result = r.redact(text)
                            self.assertNotIn('Fake#Pass123', result)
                            self.assertIn(label + sep + '[redacted]', result)
                            self.assertEqual(r.redact(result), result)

    def test_vendor_login_and_long_tokens(self):
        for value in ['eyJfake.eyJpayload.fakeSignature', 'sk_FakeVendorKey123456789',
                      'pk_FakeVendorKey123456789', 'lin_api_FakeVendorKey123456789',
                      'ghp_FakeVendorKey123456789', 'gho_FakeVendorKey123456789',
                      'xoxb-FakeVendorKey123456789', 'xoxp-FakeVendorKey123456789',
                      'Abcdef1234567890Abcdef1234567890Abcdef']:
            self.assertEqual(r.redact(value), '[redacted]')
            url = 'https://example.com/' + value
            self.assertEqual(r.redact(url), url)
        for sep in [' / ', ', ', ' | ', '\n', ' ']:
            self.assertEqual(r.redact('qa@example.com' + sep + 'Fake#Pass123'),
                             'qa@example.com' + sep + '[redacted]')

    def test_wrapped_label_separator_matrix(self):
        for label in LABELS:
            for wrapper in ['"', "'", '`', '**', '__', '*', '_']:
                for sep in [': ', ' - ', '\n', ' ']:
                    text = wrapper + label + wrapper + sep + 'Fake#Pass123'
                    with self.subTest(label=label, wrapper=wrapper, sep=sep):
                        result = r.redact(text)
                        self.assertNotIn('Fake#Pass123', result)
                        self.assertIn(wrapper + label + wrapper, result)
                        self.assertEqual(r.redact(result), result)
        self.assertNotIn('Fake#Pass123', r.redact('{"password":"Fake#Pass123"}'))
        for label in LABELS:
            for wrapper in ['"', "'", '`', '**', '__', '*', '_']:
                for sep in [':', ' =', ' -', ' –', ' —', ' ->', ' =>']:
                    text = wrapper + label + sep + wrapper + ' Fake#Pass123'
                    with self.subTest(text=text):
                        result = r.redact(text)
                        self.assertNotIn('Fake#Pass123', result)
                        self.assertEqual(r.redact(result), result)

    def test_grouped_codes_phrases_and_url_quotes(self):
        for label in ['otp', 'pin', '2fa', 'mfa', 'code', 'passcode']:
            for value in ['482 913', '48-29-13', '4829 1348', '48 29 13']:
                self.assertEqual(r.redact(label + ': ' + value), label + ': [redacted]')
                for wrapper in ['"', "'", '`', '**', '__', '*', '_']:
                    for text in [wrapper + label + wrapper + ': ' + value, wrapper + label + ':' + wrapper + ' ' + value]:
                        result = r.redact(text)
                        self.assertNotIn(value.split()[0], result)
                        self.assertNotIn('913', result)
        for label in ['seed', 'mnemonic', 'recovery phrase', 'recovery_phrase', 'recovery-phrase']:
            for count in [12, 15, 18, 21, 24]:
                self.assertEqual(r.redact(label + ': ' + ' '.join(['fake'] * count)), label + ': [redacted]')
                for width in [1, 3, 6]:
                    words = ['fake'] * count
                    value = '\n'.join(' '.join(words[i:i+width]) for i in range(0, count, width))
                    self.assertEqual(r.redact(label + ': ' + value), label + ': [redacted]')
                for wrapper in ['"', "'", '`', '**', '__', '*', '_']:
                    for text in [wrapper + label + wrapper + ': ' + value, wrapper + label + ':' + wrapper + ' ' + value]:
                        result = r.redact(text)
                        self.assertNotIn(value.split()[0], result)
                        self.assertNotIn('913', result)
        for sep in [' / ', ', ', ' | ']:
            self.assertEqual(r.redact('qa@example.com' + sep + 'FakeAlphabetic'), 'qa@example.com' + sep + '[redacted]')
        self.assertEqual(r.redact('qa@example.com review tomorrow'), 'qa@example.com review tomorrow')
        for wrapper in ['"', "'", '`']:
            self.assertEqual(r.redact('password: ' + wrapper + 'FakePrefix https://example.com/x FakeSuffix99' + wrapper), 'password: [redacted]')
            for sep in [' / ', ', ', ' | ', '\n']:
                for content in ['F1', 'Fake1 https://e.test/x Tail9', 'FakePassword https://example.test/path FakeTail99', 'Fake ' * 30 + 'Tail99']:
                    value = wrapper + content + wrapper
                    self.assertEqual(r.redact('qa@example.com' + sep + value), 'qa@example.com' + sep + '[redacted]')

    def test_technical_contexts_and_typed_hashes(self):
        for text in ['HTTP status code 503', 'HTTP code 503', 'error code 1234', 'exit code 1',
                     'response code: 503', 'password hashing needs fixing', 'private key encryption changed']:
            self.assertEqual(r.redact(text), text)
        sha = '0123456789abcdef0123456789abcdef01234567'
        for key in ['headRefOid', 'head_sha', 'sha', 'trace']:
            self.assertEqual(r.redact_fields({key: sha})[key], sha)
        for label in ['Head ', 'git ', 'trace: ', 'commit sha ']:
            self.assertEqual(r.redact(label + sha), label + sha)
        self.assertEqual(r.redact('password: ' + sha), 'password: [redacted]')
        self.assertEqual(r.redact(sha), '[redacted]')

    def test_multiline_quotes_and_truncated_quote(self):
        for value in ['"fake\npass 99"', "'fake\\' pass 99'", '`fake\npass 99`', '"fake pass 99']:
            self.assertNotIn('99', r.redact('password: ' + value))
        self.assertEqual(r.redact_fields({'prompt': CASES[0][0], 'n': 4})['n'], 4)


if __name__ == '__main__':
    unittest.main()
