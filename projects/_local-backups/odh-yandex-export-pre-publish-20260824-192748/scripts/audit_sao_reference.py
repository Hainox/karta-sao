#!/usr/bin/env python3
"""Create transparent review artifacts from the reference PDF and match report."""
from __future__ import annotations
import argparse, csv
from pathlib import Path
from pypdf import PdfReader

LEGEND = [
    ("База ДЭУ", "symbol"), ("Гидрант", "symbol"),
    ("Места хранения реагента", "symbol"), ("ССП МВС", "symbol"),
    ("ССП МВК", "symbol"), ("Места временного складирования снега", "symbol"),
    ("Транспортно-пересадочный узел", "symbol"),
    ("Учреждения здравоохранения", "symbol"),
    ("1-я очередь", "#ff2b20"), ("2-я очередь", "#112a9e"), ("3-я очередь", "#28c934"),
]
FIELDS = ["source_name", "registry_name", "match_method", "similarity", "review_status", "note"]


def main() -> int:
    p=argparse.ArgumentParser(); p.add_argument('--pdf',type=Path,required=True); p.add_argument('--match-report',type=Path,required=True); p.add_argument('--output-dir',type=Path,required=True); a=p.parse_args()
    a.output_dir.mkdir(parents=True,exist_ok=True)
    reader=PdfReader(a.pdf)
    extracted='\n'.join(page.extract_text() or '' for page in reader.pages)
    # The supplied PDF is raster-only, hence legend evidence is recorded from visual inspection.
    audit=["# Аудит легенды карты САО", "", f"Источник: `{a.pdf.name}`; страниц: {len(reader.pages)}.",
      f"Текстовый слой PDF: {'обнаружен' if extracted.strip() else 'отсутствует (растровая карта)'}. Легенда ниже считана визуально с единственной страницы.",
      "", "## Условные обозначения"]
    audit += [f"- **{name}** — {kind}" for name,kind in LEGEND]
    audit += ["", "## Важные ограничения", "- В образце указано 658 объектов ОДХ; актуальная выгрузка реестра содержит 688. Эти цифры не смешиваются.", "- В образце есть три очереди. В текущем XLSX подтверждена только 1-я очередь; остальные ОДХ маркируются «без очередности».", "- ТПУ без геометрии ОДХ добавляются только как точечные маркеры с пометкой «ориентировочное положение, не кадастровая граница»."]
    (a.output_dir/'sao_legend_audit.md').write_text('\n'.join(audit)+'\n',encoding='utf-8')
    with a.match_report.open(encoding='utf-8-sig',newline='') as src:
        rows=list(csv.DictReader(src,delimiter=';'))
    with (a.output_dir/'sao_wave1_match_review.csv').open('w',encoding='utf-8-sig',newline='') as out:
        writer=csv.DictWriter(out,fieldnames=FIELDS,delimiter=';'); writer.writeheader()
        for r in rows:
            method=r['Метод']; source=r['Название в списке']; reg=r['Найдено в реестре']
            note='Подтверждено совпадение в реестре.' if method=='exact' else ('Нужна ручная проверка наименования.' if method=='fuzzy' else 'В реестре ОДХ не найдено; добавлять отдельным маркером, а не вымышленной геометрией ОДХ.')
            writer.writerow({'source_name':source,'registry_name':reg,'match_method':method,'similarity':r['Похожесть'],'review_status':'confirmed' if method=='exact' else 'manual_review','note':note})
    return 0
if __name__=='__main__': raise SystemExit(main())
