#!/usr/bin/env python3
"""Cross-platform command-line parsing used by `clone.py adopt` and `clone.py list`.

Each OS writes the same argv into the command line differently: Windows uses
backslashes and quotes any argument that contains a space. These tests pin the
normalization down, since the Windows branches cannot be exercised from Linux.

    python3 tests/test_clone_cmdline.py
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import clone  # noqa: E402


class CloneNameFromTest(unittest.TestCase):
    def setUp(self) -> None:
        self.home = clone.POOL_HOME
        clone.POOL_HOME = Path("/home/erema/.freebuff-pool")

    def tearDown(self) -> None:
        clone.POOL_HOME = self.home

    def test_linux_single_argument(self) -> None:
        text = ("/home/erema/freebuff-re/squashfs-root/freebuff "
                 "--user-data-dir=/home/erema/.freebuff-pool/t2/electron")
        self.assertEqual(clone.clone_name_from(text), "t2")

    def test_windows_backslashes(self) -> None:
        clone.POOL_HOME = Path(r"C:\Users\John Smith\.freebuff-pool")
        text = (r'"C:\Users\John Smith\AppData\Local\Programs\freebuff\freebuff.exe" '
                r'--user-data-dir=C:\Users\John Smith\.freebuff-pool\t2\electron')
        self.assertEqual(clone.clone_name_from(text), "t2")

    def test_windows_quote_after_equals(self) -> None:
        clone.POOL_HOME = Path(r"C:\Users\erema\.freebuff-pool")
        text = 'freebuff.exe --user-data-dir="C:\\Users\\erema\\.freebuff-pool\\full-clone\\electron"'
        self.assertEqual(clone.clone_name_from(text), "full-clone")

    def test_windows_quoted_whole_argument(self) -> None:
        clone.POOL_HOME = Path(r"C:\Users\erema\.freebuff-pool")
        text = '"--user-data-dir=C:\\Users\\erema\\.freebuff-pool\\full-clone\\electron"'
        self.assertEqual(clone.clone_name_from(text), "full-clone")

    def test_trailing_flag_is_not_part_of_the_path(self) -> None:
        text = "freebuff --user-data-dir=/home/erema/.freebuff-pool/t2/electron --no-sandbox"
        self.assertEqual(clone.clone_name_from(text), "t2")

    def test_foreign_profile_is_not_a_clone(self) -> None:
        text = "freebuff --user-data-dir=/home/erema/.config/freebuff-desktop/electron"
        self.assertIsNone(clone.clone_name_from(text))

    def test_ignores_a_plain_process(self) -> None:
        self.assertIsNone(clone.clone_name_from("/usr/bin/bash -i"))


class OwnsTest(unittest.TestCase):
    def test_linux(self) -> None:
        electron = Path("/home/erema/.freebuff-pool/t2/electron")
        text = "freebuff --user-data-dir=/home/erema/.freebuff-pool/t2/electron"
        self.assertTrue(clone.matches_user_data_dir(electron, text))

    def test_windows_quoted_path_with_spaces(self) -> None:
        electron = Path(r"C:\Users\John Smith\.freebuff-pool\t2\electron")
        text = (r'"C:\Program Files\freebuff\freebuff.exe" '
                r'"--user-data-dir=C:\Users\John Smith\.freebuff-pool\t2\electron"')
        self.assertTrue(clone.matches_user_data_dir(electron, text))

    def test_rejects_another_profile(self) -> None:
        electron = Path(r"C:\Users\erema\.freebuff-pool\t2\electron")
        text = r'"--user-data-dir=C:\Users\erema\.freebuff-pool\other\electron"'
        self.assertFalse(clone.matches_user_data_dir(electron, text))


if __name__ == "__main__":
    unittest.main(verbosity=2)
