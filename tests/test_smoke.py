from servermanage.main import main


def test_main_importable():
    assert callable(main)
