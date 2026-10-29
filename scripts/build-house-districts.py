#!/usr/bin/env python3
"""Build house-districts.csv from Wikipedia's 2026 House elections page.

Each row records a district's 2026 Cook PVI (as reproduced on Wikipedia), whether a
major-party incumbent is on the ballot, and which parties have general-election
candidates. The dashboard combines this baseline with the generic ballot.

Usage:
  python3 scripts/build-house-districts.py [saved-page.html] > house-districts.csv
"""

import csv
import re
import sys
import urllib.request
from html.parser import HTMLParser

URL = "https://en.wikipedia.org/w/index.php?title=2026_United_States_House_of_Representatives_elections&action=render"

STATES = {
    "Alabama": "AL", "Alaska": "AK", "Arizona": "AZ", "Arkansas": "AR", "California": "CA",
    "Colorado": "CO", "Connecticut": "CT", "Delaware": "DE", "Florida": "FL", "Georgia": "GA",
    "Hawaii": "HI", "Idaho": "ID", "Illinois": "IL", "Indiana": "IN", "Iowa": "IA",
    "Kansas": "KS", "Kentucky": "KY", "Louisiana": "LA", "Maine": "ME", "Maryland": "MD",
    "Massachusetts": "MA", "Michigan": "MI", "Minnesota": "MN", "Mississippi": "MS",
    "Missouri": "MO", "Montana": "MT", "Nebraska": "NE", "Nevada": "NV", "New Hampshire": "NH",
    "New Jersey": "NJ", "New Mexico": "NM", "New York": "NY", "North Carolina": "NC",
    "North Dakota": "ND", "Ohio": "OH", "Oklahoma": "OK", "Oregon": "OR", "Pennsylvania": "PA",
    "Rhode Island": "RI", "South Carolina": "SC", "South Dakota": "SD", "Tennessee": "TN",
    "Texas": "TX", "Utah": "UT", "Vermont": "VT", "Virginia": "VA", "Washington": "WA",
    "West Virginia": "WV", "Wisconsin": "WI", "Wyoming": "WY",
}

PARTY_SIDES = {"Republican": "R", "Democratic": "D", "DFL": "D"}


class TableParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.tables, self.stack, self.row, self.cell = [], [], None, None

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self.stack.append([])
        elif tag == "tr" and self.stack:
            self.row = []
            self.stack[-1].append(self.row)
        elif tag in ("td", "th") and self.row is not None:
            self.cell = [""]
            self.row.append(self.cell)
        elif tag == "br" and self.cell is not None:
            self.cell[0] += "\n"

    def handle_endtag(self, tag):
        if tag == "table" and self.stack:
            self.tables.append(self.stack.pop())
        elif tag in ("td", "th"):
            self.cell = None

    def handle_data(self, data):
        if self.cell is not None:
            self.cell[0] += data


def candidate_sides(text):
    sides = set()
    for party in re.findall(r"\(([^)]+)\)", text):
        sides.add(PARTY_SIDES.get(party.strip(), "I"))
    return "".join(sorted(sides))


def main():
    if len(sys.argv) > 1:
        page = open(sys.argv[1], encoding="utf-8").read()
    else:
        request = urllib.request.Request(URL, headers={"User-Agent": "spockpoll-data/1.0"})
        page = urllib.request.urlopen(request, timeout=60).read().decode("utf-8")

    parser = TableParser()
    parser.feed(page)
    district_tables = [
        table for table in parser.tables
        if len(table) > 1 and any("PVI" in cell[0] for cell in table[1]) and any("Candidates" in cell[0] for cell in table[0])
    ]

    writer = csv.writer(sys.stdout, lineterminator="\n")
    writer.writerow(["state", "district", "pvi", "incumbent", "sides"])
    count = 0
    for table in district_tables:
        for row in table[2:]:
            cells = [cell[0].strip() for cell in row]
            # Seven cells is a seated member; five is a new or vacant seat. Shorter rows are
            # extra incumbents spanning one district after redistricting.
            if len(cells) not in (5, 7):
                continue
            match = re.fullmatch(r"(.+?)\s+(at-large|\d+)", cells[0].replace("\xa0", " "))
            pvi = re.fullmatch(r"(R|D)\+(\d+)|EVEN", cells[1])
            if not match or not pvi or match.group(1) not in STATES:
                raise SystemExit(f"Unrecognized district row: {cells[:2]}")

            lean = 0 if cells[1] == "EVEN" else int(pvi.group(2)) * (1 if pvi.group(1) == "D" else -1)
            incumbent = ""
            if len(cells) == 7 and re.search(r"renominated|advanced to general|running", cells[5], re.I):
                incumbent = PARTY_SIDES.get(cells[3], "I")
            district = 1 if match.group(2) == "at-large" else int(match.group(2))
            writer.writerow([STATES[match.group(1)], district, lean, incumbent, candidate_sides(cells[-1])])
            count += 1

    if count != 435:
        raise SystemExit(f"Expected 435 districts, found {count}")


if __name__ == "__main__":
    main()
