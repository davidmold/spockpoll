#!/usr/bin/env python3
"""Keep only November 2026 general-election rows and the columns the dashboard uses.

Usage:
  python3 scripts/trim-race-polls.py raw.csv trimmed.csv
"""

import csv
import sys

ELECTION_DATE = "2026-11-03"
COLUMNS = [
    "poll_id", "pollster", "methodology", "state", "seat_number", "start_date", "end_date",
    "question_id", "sample_size", "population", "partisan", "ranked_choice_reallocated",
    "candidate_name", "party", "pct",
]


def main(source, destination):
    with open(source, newline="", encoding="utf-8") as infile, \
            open(destination, "w", newline="", encoding="utf-8") as outfile:
        reader = csv.DictReader(infile)
        missing = [column for column in COLUMNS + ["stage", "election_date"] if column not in reader.fieldnames]
        if missing:
            raise SystemExit(f"Missing columns: {', '.join(missing)}")

        writer = csv.writer(outfile, lineterminator="\n")
        writer.writerow(COLUMNS)
        for row in reader:
            if row["election_date"] == ELECTION_DATE and row["stage"] == "general":
                writer.writerow([row[column] for column in COLUMNS])


if __name__ == "__main__":
    main(*sys.argv[1:3])
