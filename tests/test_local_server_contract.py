import unittest

from scripts.local_server_security import allowed_origin


class LocalServerContractTests(unittest.TestCase):
    def test_allows_only_known_application_origins(self):
        self.assertEqual(allowed_origin('http://127.0.0.1:5173'), 'http://127.0.0.1:5173')
        self.assertIsNone(allowed_origin('https://attacker.example'))


if __name__ == '__main__':
    unittest.main()
