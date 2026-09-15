import unittest

from scripts.local_document_server import (
    MAX_DOCUMENT_UPLOAD_BYTES,
    validate_content_length,
    validate_local_host,
    validate_zip_members,
)


class LocalDocumentSecurityTests(unittest.TestCase):
    def test_rejects_oversized_requests_before_processing(self):
        with self.assertRaises(ValueError):
            validate_content_length(MAX_DOCUMENT_UPLOAD_BYTES + 1, MAX_DOCUMENT_UPLOAD_BYTES)

    def test_only_allows_loopback_sidecar_hosts(self):
        self.assertEqual(validate_local_host('127.0.0.1'), '127.0.0.1')
        with self.assertRaises(ValueError):
            validate_local_host('0.0.0.0')

    def test_rejects_zip_bombs_by_declared_expanded_size(self):
        with self.assertRaises(ValueError):
            validate_zip_members([type('Info', (), {'file_size': MAX_DOCUMENT_UPLOAD_BYTES + 1})()])


if __name__ == '__main__':
    unittest.main()
