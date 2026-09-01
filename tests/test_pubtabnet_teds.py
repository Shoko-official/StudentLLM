import unittest

from benchmarks.run_pubtabnet_teds import extract_table_markup, levenshtein_distance


class PubTabNetTedsTests(unittest.TestCase):
    def test_extract_table_markup_removes_markdown_wrapper(self):
        self.assertEqual(extract_table_markup("```html\n<table><tr><td>A</td></tr></table>\n```"), "<table><tr><td>A</td></tr></table>")

    def test_extract_table_markup_rejects_non_table_output(self):
        self.assertEqual(extract_table_markup("I cannot reconstruct this table."), "")

    def test_levenshtein_distance_is_symmetric(self):
        self.assertEqual(levenshtein_distance("table", "tables"), levenshtein_distance("tables", "table"))


if __name__ == "__main__":
    unittest.main()
