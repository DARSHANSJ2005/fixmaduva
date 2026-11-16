#!/usr/bin/env python3
"""Build Bengaluru-area assembly polygons and join them to the official MLA list."""

import html.parser
import json
import re
import struct
import urllib.request
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
SHAPE_URL = "https://raw.githubusercontent.com/datameet/maps/master/assembly-constituencies/India_AC.shp"
DBF_URL = "https://raw.githubusercontent.com/datameet/maps/master/assembly-constituencies/India_AC.dbf"
MLA_URL = "https://kla.kar.nic.in/assembly/member/16assemblymemberslist.htm"
BOUNDARY_SOURCE = "https://github.com/datameet/maps/tree/master/assembly-constituencies"
BOUNDARY_LICENSE = "Creative Commons Attribution 2.5 India"
BBOX = (77.2, 12.6, 78.0, 13.25)


def download(url):
    request = urllib.request.Request(url, headers={"User-Agent": "FixMaduva open-data builder"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read(), response.headers


def read_dbf(data):
    record_count = struct.unpack_from("<I", data, 4)[0]
    header_size = struct.unpack_from("<H", data, 8)[0]
    record_size = struct.unpack_from("<H", data, 10)[0]
    fields = []
    for offset in range(32, header_size - 1, 32):
        descriptor = data[offset:offset + 32]
        if descriptor[0] == 13:
            break
        name = descriptor[:11].split(b"\0", 1)[0].decode("ascii")
        fields.append((name, descriptor[16]))

    records = []
    for index in range(record_count):
        row_data = data[header_size + index * record_size:header_size + (index + 1) * record_size]
        if not row_data or row_data[0] == 42:
            records.append(None)
            continue
        cursor = 1
        row = {}
        for name, width in fields:
            row[name] = row_data[cursor:cursor + width].decode("cp1252").strip()
            cursor += width
        records.append(row)
    return records


def read_shape_records(data):
    records = []
    offset = 100
    while offset + 8 <= len(data):
        _, content_words = struct.unpack_from(">2i", data, offset)
        offset += 8
        content_size = content_words * 2
        content = data[offset:offset + content_size]
        offset += content_size
        shape_type = struct.unpack_from("<i", content, 0)[0]
        if shape_type == 0:
            records.append(None)
            continue
        if shape_type != 5:
            raise ValueError(f"Expected Polygon records, got shape type {shape_type}.")

        xmin, ymin, xmax, ymax = struct.unpack_from("<4d", content, 4)
        part_count, point_count = struct.unpack_from("<2i", content, 36)
        part_offset = 44
        point_offset = part_offset + part_count * 4
        parts = list(struct.unpack_from(f"<{part_count}i", content, part_offset))
        points = [
            struct.unpack_from("<2d", content, point_offset + index * 16)
            for index in range(point_count)
        ]
        rings = [
            points[start:parts[index + 1] if index + 1 < part_count else point_count]
            for index, start in enumerate(parts)
        ]
        records.append(((xmin, ymin, xmax, ymax), rings))
    return records


def read_mlas(html_bytes):
    class TableParser(html.parser.HTMLParser):
        def __init__(self):
            super().__init__(convert_charrefs=True)
            self.rows = []
            self.row = None
            self.cell = None

        def handle_starttag(self, tag, attrs):
            if tag.lower() == "tr":
                self.row = []
            elif tag.lower() == "td" and self.row is not None:
                self.cell = []
            elif tag.lower() == "br" and self.cell is not None:
                self.cell.append("\n")

        def handle_data(self, data):
            if self.cell is not None:
                self.cell.append(data)

        def handle_endtag(self, tag):
            if tag.lower() == "td" and self.cell is not None:
                text = "".join(self.cell)
                self.row.append("\n".join(" ".join(line.split()) for line in text.splitlines()))
                self.cell = None
            elif tag.lower() == "tr" and self.row is not None:
                self.rows.append(self.row)
                self.row = None

    parser = TableParser()
    parser.feed(html_bytes.decode("utf-8", errors="replace"))
    members = {}
    for row in parser.rows:
        if len(row) < 4:
            continue
        number_match = re.search(r"\((\d{1,3})\)", row[1])
        if not number_match:
            continue
        ac_no = number_match.group(1)
        english_constituency = re.split(r"[\u0080-\uffff]", row[1], maxsplit=1)[0].strip()
        constituency = re.sub(r"\s*\(\d{1,3}\)\s*$", "", english_constituency)
        member = re.split(r"[\u0080-\uffff]", row[2].split("\n", 1)[0], maxsplit=1)[0].strip().title()
        party = re.split(r"[\u0080-\uffff]", row[3].split("\n", 1)[0], maxsplit=1)[0].strip()
        if member and constituency:
            members[ac_no] = {
                "constituency": constituency,
                "mla": member,
                "party": party,
            }
    return members


def overlaps_bengaluru(bbox):
    xmin, ymin, xmax, ymax = bbox
    west, south, east, north = BBOX
    return xmin <= east and xmax >= west and ymin <= north and ymax >= south


def rounded_rings(rings):
    return [
        [[round(lon, 5), round(lat, 5)] for lon, lat in ring]
        for ring in rings
    ]


def build():
    shp, _ = download(SHAPE_URL)
    dbf, _ = download(DBF_URL)
    roster, roster_headers = download(MLA_URL)
    rows = read_dbf(dbf)
    shapes = read_shape_records(shp)
    mlas = read_mlas(roster)

    if len(rows) != len(shapes):
        raise ValueError(f"DBF and SHP record counts differ ({len(rows)} vs {len(shapes)}).")
    districts = defaultdict(list)
    for row, shape in zip(rows, shapes):
        if not row or not shape or row.get("ST_NAME", "").upper() != "KARNATAKA":
            continue
        ac_no = row.get("AC_NO", "")
        ac_name = row.get("AC_NAME", "").strip()
        bbox, rings = shape
        if ac_no in ("", "0") or not ac_name or not overlaps_bengaluru(bbox):
            continue
        current = mlas.get(ac_no)
        if not current:
            continue
        key = (ac_no, ac_name)
        districts[key].append(rings)

    from datetime import datetime, timezone
    checked_at = datetime.now(timezone.utc).isoformat()
    features = []
    for (ac_no, boundary_name), polygons in sorted(districts.items(), key=lambda item: int(item[0][0])):
        member = mlas[ac_no]
        geometry = {
            "type": "MultiPolygon",
            "coordinates": [rounded_rings(rings) for rings in polygons],
        }
        features.append({
            "type": "Feature",
            "properties": {
                "acNo": int(ac_no),
                "constituency": member["constituency"],
                "boundaryName": boundary_name,
                "mla": member["mla"],
                "party": member["party"],
                "mlaSource": MLA_URL,
                "mlaRosterLastModified": roster_headers.get("Last-Modified", ""),
                "mlaRosterCheckedAt": checked_at,
                "boundarySource": BOUNDARY_SOURCE,
                "boundaryLicense": BOUNDARY_LICENSE,
                "boundaryCaveat": "Community digitization of ECI-derived boundaries; verify a boundary match with official election services.",
            },
            "geometry": geometry,
        })

    if not features:
        raise ValueError("No current MLA boundaries intersected the Bengaluru map extent.")
    DATA.mkdir(exist_ok=True)
    output = DATA / "bengaluru-assembly-mlas.geojson"
    output.write_text(json.dumps({
        "type": "FeatureCollection",
        "metadata": {
            "name": "Bengaluru area assembly constituencies and current MLAs",
            "generatedAt": checked_at,
            "mlaRosterSource": MLA_URL,
            "mlaRosterLastModified": roster_headers.get("Last-Modified", ""),
            "mlaRosterCheckedAt": checked_at,
            "boundarySource": BOUNDARY_SOURCE,
            "boundaryLicense": BOUNDARY_LICENSE,
            "boundaryCaveat": "DataMeet notes possible shifts and missing constituency names in its India-wide boundary dataset. Matches are approximate; verify with official election services.",
            "attribution": "Assembly constituency boundaries © DataMeet Community Maps Project, CC BY 2.5 India. Current member names © Karnataka Legislative Assembly.",
        },
        "features": features,
    }, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"Wrote {len(features)} Bengaluru-area constituency boundaries to {output}")
    print(f"Official MLA roster last modified: {roster_headers.get('Last-Modified', 'unknown')}")


if __name__ == "__main__":
    build()
