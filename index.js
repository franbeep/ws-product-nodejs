require('dotenv').config();
const express = require('express');
const pg = require('pg');
const cors = require('cors');
const {
  rateLimitHandlerV1,
  rateLimitHandlerV2,
  rateLimitHandlerV3,
} = require('./limiters');

const app = express();
// configs come from standard PostgreSQL env vars
// https://www.postgresql.org/docs/9.6/static/libpq-envars.html
const pool = new pg.Pool();

const queryHandler = (req, res, next) => {
  pool
    .query(req.sqlQuery)
    .then(r => {
      return res.json(r.rows || []);
    })
    .catch(next);
};

const apiRouteHandler = (req, res, next) => {
  switch (req.query.api) {
    case '1':
      return rateLimitHandlerV1(req, res, next);
    case '2':
      return rateLimitHandlerV2(req, res, next);
    case '3':
      return rateLimitHandlerV3(req, res, next);
    default:
      return rateLimitHandlerV2(req, res, next);
  }
};

app.use(cors());

// endpoints

app.get('/', (req, res) => {
  res.send('Welcome to EQ Works 😊!');
});

app.get(
  '/events/hourly',
  (req, res, next) => {
    let range = '';
    if (req.query.startDate && req.query.endDate) {
      range = `WHERE date >= '${req.query.startDate}' AND date <= '${req.query.endDate}'`;
    } else if (req.query.startDate) {
      range = `WHERE date = '${req.query.startDate}'`;
    }
    req.sqlQuery = `
    SELECT date, hour, events
    FROM public.hourly_events
    ${range}
    ORDER BY date, hour
    LIMIT 50;
  `;
    return next();
  },
  apiRouteHandler,
  queryHandler
);

app.get(
  '/events/daily',
  (req, res, next) => {
    let range = '';
    if (req.query.startDate && req.query.endDate) {
      range = `WHERE date >= '${req.query.startDate}' AND date <= '${req.query.endDate}'`;
    } else if (req.query.startDate) {
      range = `WHERE date = '${req.query.startDate}'`;
    }
    req.sqlQuery = `
    SELECT date, SUM(events) AS events
    FROM public.hourly_events
    ${range}
    GROUP BY date
    ORDER BY date
    LIMIT 20;
  `;
    return next();
  },
  apiRouteHandler,
  queryHandler
);

app.get(
  '/stats/hourly',
  (req, res, next) => {
    let range = '';
    if (req.query.startDate && req.query.endDate) {
      range = `WHERE date >= '${req.query.startDate}' AND date <= '${req.query.endDate}'`;
    } else if (req.query.startDate) {
      range = `WHERE date = '${req.query.startDate}'`;
    }
    req.sqlQuery = `
    SELECT date, hour, impressions, clicks, revenue
    FROM public.hourly_stats
    ${range}
    ORDER BY date, hour
    LIMIT 50;
  `;
    return next();
  },
  apiRouteHandler,
  queryHandler
);

app.get(
  '/stats/daily',
  (req, res, next) => {
    let range = '';
    if (req.query.startDate && req.query.endDate) {
      range = `WHERE date >= '${req.query.startDate}' AND date <= '${req.query.endDate}'`;
    } else if (req.query.startDate) {
      range = `WHERE date = '${req.query.startDate}'`;
    }
    req.sqlQuery = `
    SELECT date,
        SUM(impressions) AS impressions,
        SUM(clicks) AS clicks,
        SUM(revenue) AS revenue
    FROM public.hourly_stats
    ${range}
    GROUP BY date
    ORDER BY date
    LIMIT 20;
  `;
    return next();
  },
  apiRouteHandler,
  queryHandler
);

app.get(
  '/poi',
  (req, res, next) => {
    req.sqlQuery = `
    SELECT *
    FROM public.poi;
  `;
    return next();
  },
  apiRouteHandler,
  queryHandler
);

app.listen(process.env.PORT || 5555, err => {
  if (err) {
    console.error(err);
    process.exit(1);
  } else {
    console.log(`Running on ${process.env.PORT || 5555}`);
  }
});

// last resorts
process.on('uncaughtException', err => {
  console.log(`Caught exception: ${err}`);
  process.exit(1);
});
process.on('unhandledRejection', (reason, p) => {
  console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
  process.exit(1);
});
