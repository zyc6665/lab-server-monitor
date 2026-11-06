from pathlib import Path

from servermanage.disk_health import (
    parse_controllers,
    parse_physical_drives,
    parse_physical_drives_text,
    parse_temperature,
    parse_virtual_drives,
)

FIX = Path(__file__).parent / "fixtures" / "storcli"


def test_parse_a100_six_drives():
    drives = parse_physical_drives((FIX / "a100__c0_eall_sall_show_all_J.json").read_text())
    assert len(drives) == 6
    assert all(d.state and "Onln" in d.state for d in drives)
    assert all(d.media_errors == 0 for d in drives)
    assert all(20 <= d.temperature_c <= 45 for d in drives)


def test_parse_4090_two_controllers():
    drives = parse_physical_drives((FIX / "4090__c0_eall_sall_show_all_J.json").read_text()) \
           + parse_physical_drives((FIX / "4090__c1_eall_sall_show_all_J.json").read_text())
    assert {d.controller for d in drives} == {0, 1}
    assert len(drives) == 8


def test_parse_v100_and_h100_counts():
    assert len(parse_physical_drives((FIX / "v100__c0_eall_sall_show_all_J.json").read_text())) == 2
    assert len(parse_physical_drives((FIX / "h100__c0_eall_sall_show_all_J.json").read_text())) == 5


def test_parse_temperature_variants():
    assert parse_temperature(" 27C (80.60 F)") == 27
    assert parse_temperature("N/A") is None
    assert parse_temperature(None) is None
    assert parse_temperature(31) == 31


def test_text_fallback():
    text = """
Drive /c0/e252/s3 - Detailed Information:
Drive /c0/e252/s3 State:
Media Error Count = 3
Other Error Count = 1
Predictive Failure Count = 0
S.M.A.R.T alert flagged by drive = Yes
Drive Temperature = 41C (105.80 F)
"""
    drives = parse_physical_drives_text(text)
    assert len(drives) == 1
    d = drives[0]
    assert (d.controller, d.enclosure, d.slot) == (0, 252, 3)
    assert d.media_errors == 3 and d.other_errors == 1
    assert d.smart_alert is True and d.temperature_c == 41


def test_physical_drive_detail_fields():
    drives = parse_physical_drives((FIX / "a100__c0_eall_sall_show_all_J.json").read_text())
    d = drives[0]
    assert (d.controller, d.enclosure, d.slot, d.did) == (0, 252, 0, 9)
    assert d.model == "Samsung SSD 870 EVO 1TB"
    assert d.serial == "S6PVNX0T205787W"
    assert d.smart_alert is False
    assert d.shield_counter == 0
    assert d.predictive_failures == 0


def test_parse_controllers_a100_leading_junk():
    # a100_cALL_show_J.json begins with a stray "IMG=dili-ui:latest" line before the JSON.
    controllers = parse_controllers((FIX / "a100_cALL_show_J.json").read_text())
    assert len(controllers) == 1
    assert controllers[0].controller == 0
    assert "MegaRAID" in controllers[0].model
    assert controllers[0].firmware == "4.680.00-8561"


def test_parse_controllers_4090_multi():
    controllers = parse_controllers((FIX / "4090_cALL_show_J.json").read_text())
    assert {c.controller for c in controllers} == {0, 1}


def test_parse_virtual_drives_a100():
    vds = parse_virtual_drives((FIX / "a100__c0_vall_show_J.json").read_text(), controller=0)
    assert [v.vd_id for v in vds] == [0, 1]
    assert vds[0].raid_level == "RAID1"
    assert vds[0].state == "Optl"
    assert vds[1].size == "21.830 TB"
