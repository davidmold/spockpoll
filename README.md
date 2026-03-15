# SpockPoll — Presidential Approval Polling Dashboard

A live, auto-updating tracker of Donald Trump's presidential job approval polls, featuring a weighted polling average model inspired by Nate Silver's methodology.

**[View the live dashboard →](https://davidmold.github.io/spockpoll/)**

## What it does

- **Weighted polling average** with 90% prediction bands, accounting for recency, sample size, methodology quality, population type, partisan lean, and pollster house effects
- **House effect estimation** — iterative algorithm with Bayesian shrinkage identifies each pollster's systematic bias
- **Event analysis** — controls for pollster composition effects (e.g. did approval *actually* shift after the Iran strikes, or did the mix of active pollsters just change?)
- **Interactive filters** — slice by population type (likely voters / registered voters / adults) and sponsor type
- **Multiple visualizations** — trend charts, net approval, methodology breakdown, pollster comparison, sample size scatter, monthly averages
- **Auto-updating** — GitHub Action fetches fresh data from NYT daily at 6:00 AM UTC

## How the model works

The weighted average uses a Nadaraya-Watson kernel regression with exponential decay:

| Factor | How it's weighted |
|--------|------------------|
| **Recency** | 14-day half-life exponential decay — a poll from 2 weeks ago counts 50% |
| **Sample size** | Weight scales with √n — a 4,000-person poll counts ~2.6× more than a 600-person poll |
| **Methodology** | Live phone & probability panels: 100%. Mixed: 85%. Online nonprobability: 70%. Unknown: 65% |
| **Population** | Likely voters: 100%. Registered voters: 95%. All adults: 80% |
| **Partisan lean** | Party-sponsored polls (REP/DEM) receive 50% weight |
| **House effects** | Each pollster's systematic bias is estimated iteratively and corrected, with shrinkage toward zero for pollsters with few polls |

Confidence bands show the 90% prediction interval (where we'd expect individual polls to fall), inflated by 1.3× for model uncertainty — similar in spirit to the Silver Bulletin's approach.

## Tech stack

Intentionally minimal — the entire dashboard is a single HTML file:

- **[Chart.js 4.4.7](https://www.chartjs.org/)** — charts and visualizations
- **[chartjs-adapter-date-fns](https://github.com/chartjs/chartjs-adapter-date-fns)** — time axis handling
- **Vanilla JS** — no frameworks, no build step, no dependencies to manage
- **GitHub Pages** — free static hosting with CDN
- **GitHub Actions** — automated daily data refresh

## Data

Polling data sourced from [The New York Times / FiveThirtyEight](https://www.nytimes.com/interactive/2024/us/elections/polls/approval-rating/donald-trump.html) presidential approval polls.

Licensed under [Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/).

## Updating data

Data refreshes automatically via GitHub Actions. To update manually:

```bash
./update-data.sh
```

Or trigger the action from the [Actions tab](https://github.com/davidmold/spockpoll/actions) → "Update Polling Data" → "Run workflow".

## License

The polling data is CC BY 4.0 (NYT/FiveThirtyEight). The dashboard code is MIT — do whatever you like with it.
