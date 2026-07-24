import budget_api


class TestPackageWiring:
    def test_package_imports_and_exposes_version(self):
        assert budget_api.__version__ == "0.1.0"
