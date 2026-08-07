# SpockPoll — Approval & the Economy

A lightweight, auto-updating dashboard that pairs Donald Trump's presidential job approval with five U.S. economic indicators.

**[View the live dashboard →](https://davidmold.github.io/spockpoll/)**

## What it shows

- **Weighted polling average** with 90% prediction bands, accounting for recency, sample size, methodology, population type, partisan sponsorship, outliers, tracker frequency, and pollster house effects
- **Weighted net approval** with Full term / 1Y / 6M / 90D / 30D range controls
- **Stock indexes** — S&P 500, NASDAQ Composite, and Dow Jones daily closes over the latest 12 months, rebased to 100 for comparison with latest prices shown separately
- **Consumer Price Index** — seasonally adjusted monthly CPI-U
- **Monthly change in jobs** — change in seasonally adjusted nonfarm payrolls with a three-month moving average
- **Average U.S. gas price** — weekly regular gasoline price per gallon
- **U.S. trade deficit** — monthly goods and services deficit
- **Accessible chart data** — each economic visualization includes an expandable HTML data table

## How the polling model works

The weighted average uses local-linear kernel regression with exponential decay. A weighted least-squares line is fitted through nearby polls and evaluated for each day, avoiding the endpoint lag of a flat moving average.

| Factor | Weighting approach |
|---|---|
| Recency | 14-day half-life exponential decay |
| Sample size | Weight scales with √n and is capped at 10,000 respondents |
| Methodology | Probability-based methods receive the highest weight; unknown methods receive 65% |
| Population | Likely voters 100%, registered voters 95%, adults 80% |
| Sponsorship | Party-sponsored polls receive 50% weight |
| House effects | Iteratively estimated and corrected with shrinkage for low-volume pollsters |
| Outliers | Residuals beyond 2.5σ are Huber-downweighted before refitting |
| Trackers | Each pollster's volume is √-damped so frequent trackers cannot dominate |

The pastel bands are 90% prediction intervals for individual polls, inflated by 1.3× for model uncertainty.

## Data sources

Polling data comes from [The New York Times / FiveThirtyEight](https://www.nytimes.com/interactive/2024/us/elections/polls/approval-rating/donald-trump.html).

Economic data is cached from [FRED, Federal Reserve Bank of St. Louis](https://fred.stlouisfed.org/) using these series:

| Indicator | FRED series |
|---|---|
| S&P 500 | `SP500` |
| NASDAQ Composite | `NASDAQCOM` |
| Dow Jones Industrial Average | `DJIA` |
| CPI-U | `CPIAUCSL` |
| Total nonfarm payrolls | `PAYEMS` |
| Regular gasoline | `GASREGW` |
| Trade balance | `BOPGSTB` |

The original agencies include the Bureau of Labor Statistics, Energy Information Administration, Census Bureau, and Bureau of Economic Analysis. Market series may be subject to provider terms.

## Running locally

There is no build step. Serve the repository with any static web server:

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080`.

## Updating data

The daily GitHub Action refreshes both local CSV caches. To update them manually:

```bash
./update-data.sh
```

The updater downloads to temporary files, validates each response, and only replaces a cache after a complete successful refresh.

## Tech stack

- Chart.js 4.4.7 and chartjs-adapter-date-fns
- Vanilla JavaScript and CSS
- GitHub Pages and GitHub Actions

## License

Polling data is licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Dashboard code is MIT. Review the cited providers' terms before redistributing market series.
