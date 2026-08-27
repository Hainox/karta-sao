from pathlib import Path
import csv

def test_match_review_has_required_columns():
    with Path('outputs/sao_wave1_match_review.csv').open(encoding='utf-8-sig',newline='') as stream:
        assert csv.DictReader(stream,delimiter=';').fieldnames == ['source_name','registry_name','match_method','similarity','review_status','note']

def test_snow_csv_has_addresses():
    with Path('outputs/sao_snow_storage_sites.csv').open(encoding='utf-8-sig',newline='') as stream:
        assert len(list(csv.DictReader(stream,delimiter=';'))) >= 20
