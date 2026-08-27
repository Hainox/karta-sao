from pathlib import Path

svg = '''<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="680" viewBox="0 0 1000 680">
<defs>
  <marker id="redArrow" markerWidth="12" markerHeight="12" refX="9" refY="4" orient="auto"><path d="M0 0 L0 8 L10 4z" fill="#e00000"/></marker>
  <pattern id="snow" width="14" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="14" height="14" fill="#d5eaf6"/><path d="M0 0V14" stroke="#9fc6df" stroke-width="2"/></pattern>
  <pattern id="grass" width="13" height="13" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="13" height="13" fill="#a4ce95"/><path d="M0 0V13" stroke="#86b679" stroke-width="2"/></pattern>
</defs>
<rect width="1000" height="680" fill="#f7f9fb"/>
<rect x="42" y="42" width="916" height="548" fill="#92979c" stroke="#788087" stroke-width="2"/>
<!-- проезд и два корпуса -->
<rect x="102" y="142" width="682" height="104" fill="url(#grass)" stroke="#6a8164" stroke-width="2"/>
<rect x="102" y="360" width="682" height="105" fill="url(#grass)" stroke="#6a8164" stroke-width="2"/>
<rect x="146" y="82" width="595" height="80" fill="#cbd0d4" stroke="#8d959b" stroke-width="2"/>
<rect x="146" y="445" width="595" height="80" fill="#cbd0d4" stroke="#8d959b" stroke-width="2"/>
<text x="443" y="130" text-anchor="middle" font-family="Arial" font-size="15" font-weight="700" fill="#56626b">корпус 1 · 1-й Амбулаторный проезд, д. 5, к. 1</text>
<text x="443" y="494" text-anchor="middle" font-family="Arial" font-size="15" font-weight="700" fill="#56626b">корпус 2 · 1-й Амбулаторный проезд, д. 5, к. 2</text>
<!-- места для безопасного выброса по итогам осмотра -->
<rect x="112" y="259" width="142" height="88" fill="url(#snow)" stroke="#5a98bd" stroke-width="2"/>
<rect x="632" y="259" width="142" height="88" fill="url(#snow)" stroke="#5a98bd" stroke-width="2"/>
<rect x="154" y="289" width="58" height="28" rx="6" fill="#fff" stroke="#5a98bd" stroke-width="2"/><text x="183" y="309" text-anchor="middle" font-family="Arial" font-size="15" font-weight="700" fill="#176395">Н-4</text>
<rect x="674" y="289" width="58" height="28" rx="6" fill="#fff" stroke="#5a98bd" stroke-width="2"/><text x="703" y="309" text-anchor="middle" font-family="Arial" font-size="15" font-weight="700" fill="#176395">Н-4</text>
<!-- деревья и запретные зоны -->
<g fill="#9dbc76" stroke="#62864f" stroke-width="2"><circle cx="290" cy="194" r="26"/><circle cx="364" cy="194" r="26"/><circle cx="438" cy="194" r="26"/><circle cx="512" cy="194" r="26"/><circle cx="586" cy="194" r="26"/><circle cx="290" cy="412" r="26"/><circle cx="364" cy="412" r="26"/><circle cx="438" cy="412" r="26"/><circle cx="512" cy="412" r="26"/><circle cx="586" cy="412" r="26"/></g>
<g fill="none" stroke="#be3939" stroke-width="2" stroke-dasharray="3 4"><circle cx="290" cy="194" r="12"/><circle cx="364" cy="194" r="12"/><circle cx="438" cy="194" r="12"/><circle cx="512" cy="194" r="12"/><circle cx="586" cy="194" r="12"/><circle cx="290" cy="412" r="12"/><circle cx="364" cy="412" r="12"/><circle cx="438" cy="412" r="12"/><circle cx="512" cy="412" r="12"/><circle cx="586" cy="412" r="12"/></g>
<!-- челночные проходы по межкорпусному проезду -->
<g fill="none" stroke="#e00000" stroke-width="5" stroke-linecap="round">
 <path d="M273 268 H613" marker-end="url(#redArrow)"/><path d="M613 278 H273" marker-end="url(#redArrow)"/><path d="M273 288 H613" marker-end="url(#redArrow)"/><path d="M613 298 H273" marker-end="url(#redArrow)"/><path d="M273 308 H613" marker-end="url(#redArrow)"/><path d="M613 318 H273" marker-end="url(#redArrow)"/><path d="M273 328 H613" marker-end="url(#redArrow)"/><path d="M613 338 H273" marker-end="url(#redArrow)"/>
</g>
<g stroke="#fff" stroke-width="1.3" stroke-dasharray="6 5"><path d="M273 268H613"/><path d="M613 278H273"/><path d="M273 288H613"/><path d="M613 298H273"/><path d="M273 308H613"/><path d="M613 318H273"/><path d="M273 328H613"/><path d="M613 338H273"/></g>
<circle cx="443" cy="303" r="16" fill="#0f71da" stroke="#fff" stroke-width="3"/><text x="443" y="309" text-anchor="middle" font-family="Arial" font-size="16" font-weight="700" fill="#fff">1</text>
<text x="442" y="365" text-anchor="middle" font-family="Arial" font-size="15" font-weight="700" fill="#39464e">межкорпусный проезд · челночные проходы</text>
<text x="442" y="387" text-anchor="middle" font-family="Arial" font-size="13" fill="#53646d">сопло направлять только в согласованные окна, не на посадки</text>
<path d="M101 542H201M101 535V549M201 535V549" stroke="#111" stroke-width="3"/><text x="151" y="530" text-anchor="middle" font-family="Arial" font-size="12">10 м</text>
<path d="M903 542V505" stroke="#111" stroke-width="2" marker-end="url(#redArrow)"/><text x="903" y="562" text-anchor="middle" font-family="Arial" font-size="13" font-weight="700">С</text>
<text x="42" y="626" font-family="Arial" font-size="21" font-weight="700" fill="#18242c">ДТ-4 «Два корпуса». Челнок между корпусами 1 и 2; безопасные окна складирования Н-4 — только после осмотра.</text>
<text x="42" y="654" font-family="Arial" font-size="15" fill="#5a6871">Привязка: 1-й Амбулаторный проезд, д. 5, к. 1 и к. 2. Схема предварительная, без замены паспорта территории.</text>
</svg>'''
Path(r'C:\Users\root\Downloads\КАРТА\smm\dt4.svg').write_text(svg, encoding='utf-8')
print('DT-4 scheme written')
