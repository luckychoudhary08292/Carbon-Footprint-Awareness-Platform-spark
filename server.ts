import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import {
  loadDb,
  saveDb,
  calculateFootprint,
  calculateLogSavings,
  User,
  UserFootprint,
  DailyLog
} from './server/db.ts';

const PORT = 3000;

async function startServer() {
  const app = express();
  app.use(express.json());

  // Setup basic request authentication helper
  const getUserIdFromRequest = (req: express.Request): string => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.split(' ')[1];
    }
    return 'user_default'; // Fallback to seeded demo user for perfect out-of-the-box experience
  };

  // --- API ROUTES ---

  // Auth: Session Register
  app.post('/api/auth/register', (req, res) => {
    const { email, name, password } = req.body;
    if (!email || !name || !password) {
      return res.status(400).json({ error: 'Please provide all registration details.' });
    }

    const db = loadDb();
    const existing = db.users.find((u) => u.email.toLowerCase() === email.toLowerCase());
    if (existing) {
      return res.status(400).json({ error: 'This email is already registered.' });
    }

    const newUser: User = {
      id: 'user_' + Math.random().toString(36).substr(2, 9),
      email: email.toLowerCase(),
      name,
      passwordHash: password // Simplified for mock auth
    };

    db.users.push(newUser);
    saveDb(db);

    res.status(201).json({
      token: newUser.id,
      user: { id: newUser.id, name: newUser.name, email: newUser.email }
    });
  });

  // Auth: Session Login
  app.post('/api/auth/login', (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const db = loadDb();
    const user = db.users.find(
      (u) => u.email.toLowerCase() === email.toLowerCase() && u.passwordHash === password
    );

    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    res.json({
      token: user.id,
      user: { id: user.id, name: user.name, email: user.email }
    });
  });

  // Auth: Current Profile
  app.get('/api/auth/me', (req, res) => {
    const userId = getUserIdFromRequest(req);
    const db = loadDb();
    const user = db.users.find((u) => u.id === userId);

    if (!user) {
      return res.status(404).json({ error: 'User session not found.' });
    }

    res.json({ id: user.id, name: user.name, email: user.email });
  });

  // Calculations Engine Endpoint
  app.post('/api/calculate', (req, res) => {
    const userId = getUserIdFromRequest(req);
    const { vehicleType, weeklyDistance, dietType, monthlyBill } = req.body;

    if (
      !vehicleType ||
      weeklyDistance === undefined ||
      !dietType ||
      monthlyBill === undefined
    ) {
      return res.status(400).json({ error: 'Missing baseline calculation inputs.' });
    }

    const parsedWeeklyDistance = parseFloat(weeklyDistance) || 0;
    const parsedMonthlyBill = parseFloat(monthlyBill) || 0;

    // Run the computation engine
    const computed = calculateFootprint(
      vehicleType,
      parsedWeeklyDistance,
      dietType,
      parsedMonthlyBill
    );

    const db = loadDb();
    const updatedFootprint: UserFootprint = {
      userId,
      ...computed,
      updatedAt: new Date().toISOString()
    };

    db.footprints[userId] = updatedFootprint;
    saveDb(db);

    res.json(updatedFootprint);
  });

  // Daily Journal Logging Tracker Endpoint
  app.post('/api/logs/daily', (req, res) => {
    const userId = getUserIdFromRequest(req);
    const { date, actions } = req.body;

    if (!date || !actions) {
      return res.status(400).json({ error: 'Daily log date and actions matrix are required.' });
    }

    const db = loadDb();
    const co2Saved = calculateLogSavings(actions);

    // Check if entry for this date already exists to overwrite or create new
    const existingIndex = db.logs.findIndex((l) => l.userId === userId && l.date === date);

    const logEntry: DailyLog = {
      id: existingIndex !== -1 ? db.logs[existingIndex].id : 'log_' + Date.now().toString(),
      userId,
      date,
      actions,
      co2Saved
    };

    if (existingIndex !== -1) {
      db.logs[existingIndex] = logEntry;
    } else {
      db.logs.push(logEntry);
    }

    saveDb(db);
    res.json({ success: true, log: logEntry });
  });

  // Dashboard Aggregations and Visualization Data Payload
  app.get('/api/dashboard', (req, res) => {
    const userId = getUserIdFromRequest(req);
    const db = loadDb();

    // 1. Fetch user baseline footprint, fall back to seeded baseline if unregistered
    let footprint = db.footprints[userId];
    if (!footprint) {
      // Create a default clean footprint state for initial users
      footprint = {
        userId,
        vehicleType: 'none',
        weeklyDistance: 0,
        dietType: 'vegan',
        monthlyBill: 0,
        electricityKwh: 0,
        transportCo2: 0,
        dietCo2: 0.7, // Vegan baseline
        energyCo2: 0,
        totalCo2: 0.7,
        updatedAt: new Date().toISOString()
      };
    }

    // 2. Compute 7-day reduction progress
    // We will build a list of the last 7 calendar dates
    const dayLabels: string[] = [];
    const chartData: any[] = [];
    const baseDate = new Date();

    const userLogs = db.logs.filter((l) => l.userId === userId);

    for (let i = 6; i >= 0; i--) {
      const d = new Date(baseDate.getTime() - i * 24 * 60 * 60 * 1000);
      const dateString = d.toISOString().split('T')[0];
      const dayName = d.toLocaleDateString('en-US', { weekday: 'short' });

      // Find if there was any green actions log on that day
      const logToday = userLogs.find((l) => l.date === dateString);
      const savings = logToday ? logToday.co2Saved : 0;

      // Net actual daily footprint is baseline total minus what was saved that day
      const netEmissions = Math.max(0, parseFloat((footprint.totalCo2 - savings).toFixed(2)));

      chartData.push({
        date: dateString,
        day: dayName,
        'Base Footprint': parseFloat(footprint.totalCo2.toFixed(2)),
        'Your Actual Emissions': netEmissions,
        'Saved CO2': savings,
        logged: !!logToday
      });
    }

    // 3. Compute dashboard metrics
    // Total Monthly Footprint (derived from daily baseline scaled to monthly in kg)
    const totalMonthlyBaselineKg = parseFloat((footprint.totalCo2 * 30.4).toFixed(1));

    // Dynamic Carbon Savings relative to National Average
    // European national average per capita is ~20kg/day, US is ~45kg/day. Let's use 35kg/day global average baseline
    const targetNationalAverageDaily = 35.0;
    const comparisonPct = Math.round(
      ((footprint.totalCo2 - targetNationalAverageDaily) / targetNationalAverageDaily) * 100
    );

    // Calculate logging streak (consecutive days of logged entries going backward from today)
    let activeStreak = 0;
    const sortedDateLogs = [...userLogs]
      .map((l) => l.date)
      .filter((v, i, a) => a.indexOf(v) === i)
      .sort((a, b) => new Date(b).getTime() - new Date(a).getTime());

    if (sortedDateLogs.length > 0) {
      const todayStr = new Date().toISOString().split('T')[0];
      const yesterdayDate = new Date();
      yesterdayDate.setDate(yesterdayDate.getDate() - 1);
      const yesterdayStr = yesterdayDate.toISOString().split('T')[0];

      // Check if logged today or yesterday to start the streak
      if (sortedDateLogs[0] === todayStr || sortedDateLogs[0] === yesterdayStr) {
        activeStreak = 1;

        for (let idx = 0; idx < sortedDateLogs.length - 1; idx++) {
          const current = new Date(sortedDateLogs[idx]);
          const next = new Date(sortedDateLogs[idx + 1]);
          const diffMs = current.getTime() - next.getTime();
          const diffDays = diffMs / (1000 * 60 * 60 * 24);

          // If exactly 1 day apart, streak continues
          if (diffDays <= 1.1) {
            activeStreak++;
          } else {
            break; // Streak broken
          }
        }
      }
    }

    // 4. Badges Earned Computation engine
    const badges: { id: string; title: string; desc: string; icon: string; earned: boolean }[] = [
      {
        id: 'badge_onboarded',
        title: 'Platform Citizen',
        desc: 'Completed the dynamic carbon footprint onboarding quiz.',
        icon: 'Award',
        earned: footprint.updatedAt !== undefined && footprint.weeklyDistance > 0 || userId === 'user_default'
      },
      {
        id: 'badge_streak_3',
        title: 'Determined Saver',
        desc: 'Maintained a green tracking streak of at least 3 active days.',
        icon: 'Flame',
        earned: activeStreak >= 3
      },
      {
        id: 'badge_green_first',
        title: 'First Step',
        desc: 'Signed your first green action log today.',
        icon: 'Compass',
        earned: userLogs.length >= 1
      },
      {
        id: 'badge_sav_10',
        title: 'Carbon Slasher',
        desc: 'Offset or saved more than 10.0kg of CO2 emissions in logs.',
        icon: 'Shield',
        earned: userLogs.reduce((acc, current) => acc + current.co2Saved, 0) >= 10.0
      },
      {
        id: 'badge_sav_25',
        title: 'Eco Warrior',
        desc: 'Offset more than 25.0kg of CO2 baseline emissions!',
        icon: 'Zap',
        earned: userLogs.reduce((acc, current) => acc + current.co2Saved, 0) >= 25.0
      }
    ];

    res.json({
      footprint,
      chartData,
      metrics: {
        totalMonthlyBaselineKg,
        comparisonPct, // negative value means under standard, positive means exceeding average
        activeStreak,
        totalLogsCount: userLogs.length,
        totalCo2SavedKg: parseFloat(userLogs.reduce((acc, l) => acc + l.co2Saved, 0).toFixed(1))
      },
      badges,
      logs: userLogs
    });
  });

  // Actionable Personalized Recommendations Insights Engine
  app.get('/api/insights', (req, res) => {
    const userId = getUserIdFromRequest(req);
    const db = loadDb();
    let footprint = db.footprints[userId];

    if (!footprint) {
      return res.json({
        primary: {
          category: 'onboarding',
          title: 'Awaiting Calculations',
          advice: 'Complete the Eco-Onboarding quiz to generate tailored dashboard recommendations.',
          estimatedSavingsKg: 0
        },
        additional: []
      });
    }

    const { transportCo2, dietCo2, energyCo2 } = footprint;
    const insights: any[] = [];

    // Transport check
    if (transportCo2 > 0) {
      insights.push({
        category: 'Transport',
        title: 'Low-Carbon Commute Alert',
        advice: footprint.vehicleType === 'suv' 
          ? 'Switching carpools or taking public transit for 2 days a week saves up to ~15.5 kg of CO2 emissions.'
          : 'Telecommuting twice check or choosing walking/biking for short trips of less than 3km saves ~5.0 kg of CO2 weekly.',
        estimatedSavingsKg: footprint.vehicleType === 'suv' ? 15.5 : 5.0,
        priority: transportCo2
      });
    }

    // Diet check
    if (dietCo2 > 0) {
      insights.push({
        category: 'Diet',
        title: 'Green Plate Advantage',
        advice: footprint.dietType === 'meat_heavy'
          ? 'Embracing Meat-Free Mondays reduces your diet contribution by up to 2.1 kg per day of meal offsets.'
          : 'Switching vegetarian selections to vegan alternatives will shave off another 0.5 kg of CO2 today.',
        estimatedSavingsKg: footprint.dietType === 'meat_heavy' ? 2.1 : 0.5,
        priority: dietCo2
      });
    }

    // Energy check
    if (energyCo2 > 0) {
      insights.push({
        category: 'Energy',
        title: 'Energy Efficiency Boost',
        advice: footprint.monthlyBill > 100
          ? 'Lowering HVAC heating or cooling thermostat by just 2°C and unplugging inactive devices saves up to 2.4 kg of CO2 every day.'
          : 'Replacing standard lightbulbs with energy-star LED fixtures will lower your baseline usage by ~0.9 kg everyday.',
        estimatedSavingsKg: footprint.monthlyBill > 100 ? 2.4 : 0.9,
        priority: energyCo2
      });
    }

    // Sort observations descending to identify the highest emission threat
    insights.sort((a, b) => b.priority - a.priority);

    res.json({
      primary: insights[0] || {
        category: 'General',
        title: 'Pristine Eco Standard',
        advice: 'You have incredibly small footprint baselines! Log daily behaviors to earn bonus milestones.',
        estimatedSavingsKg: 1.0
      },
      additional: insights.slice(1)
    });
  });

  // Serve Vite Frontend client
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    // Serve HTML
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Carbon Footprint Awareness Server running on port ${PORT}`);
  });
}

startServer().catch((e) => {
  console.error('Fatal backend startup failure', e);
});
