"""Keep the include-filter cases discoverable without requiring pytest to import."""
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

try:
    import pytest
except ModuleNotFoundError as error:
    if error.name != "pytest":
        raise

    class IncludeFiltersTests(unittest.TestCase):
        def test_include_filters(self):
            raise unittest.SkipTest("needs pytest")
else:
    from tests._include_filters_pytest import *  # noqa: F403
