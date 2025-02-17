const express = require("express");
const cors = require("cors");
const sql = require("mssql");

const app = express();
app.use(cors());
app.use(express.json());

const dbConfig = {
  user: "regio-admin",
  password: "regi0-adm1n!!",
  server: "boulaide.database.windows.net",
  database: "boulaide",
  options: {
    encrypt: true,
    trustServerCertificate: false,
    connectTimeout: 30000, // Increase timeout to 30 sec
    requestTimeout: 30000, // Timeout for requests
  },
  pool: {
    max: 10, // Maximum number of connections in pool
    min: 1,
    idleTimeoutMillis: 30000, // Time to close idle connections
  }
};

// Global variable to store the connection pool
let globalPool;

// Initialize the connection pool once when the server starts
sql.connect(dbConfig)
  .then(pool => {
    globalPool = pool;
    console.log('Conectado ao Azure SQL');
    pool.on('error', err => {
      console.error('Erro no pool de conexões:', err);
    });
  })
  .catch(err => {
    console.error('Erro ao conectar ao banco:', err);
  });

// Helper function that waits for the pool to be ready
async function getPool() {
  if (!globalPool) {
    globalPool = await sql.connect(dbConfig);
  }
  return globalPool;
}

async function getUserByCredentials(email, password) {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input("emailParam", sql.VarChar(100), email)
      .input("passwordParam", sql.VarChar(256), password)
      .query(`
        SELECT * FROM dbo.users 
        WHERE email = @emailParam AND password = @passwordParam
      `);
    return result.recordset[0];
  } catch (err) {
    console.error('Erro ao buscar usuário:', err);
    throw err;
  }
}

async function getCustomization(user_id) {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input("userIdParam", sql.Int, user_id)
      .query(`
        SELECT c.*
        FROM dbo.user_customizations uc
        INNER JOIN dbo.customizations c ON uc.customization_id = c.customization_id
        WHERE uc.user_id = @userIdParam
      `);
    return result.recordset;
  } catch (err) {
    console.error('Erro ao buscar customizações:', err);
    throw err;
  }
}

app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Credenciais faltando" });
    }

    const user = await getUserByCredentials(email, password);
    if (!user) {
      return res.status(401).json({ error: "Credenciais inválidas" });
    }

    const customizations = await getCustomization(user.user_id);
    const equippedItems = customizations.filter(item => item.equipped);

    res.json({
      user_id: user.user_id,
      username: user.username,
      email: user.email,
      inventories: {
        inventory: customizations,
        equipped: equippedItems
      }
    });
  } catch (err) {
    console.error("Erro no login:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/inventory", async (req, res) => {
  try {
    // For testing purposes, we use user_id = 1
    const customizations = await getCustomization(1);

    if (customizations) {
      const equippedItems = customizations.filter(item => item.equipped === true);
      const customizationsObject = {
        equipped: equippedItems,
        inventory: customizations,
      };
      return res.json(customizationsObject);
    } else {
      return res.status(401).json({ success: false, message: "Invalid credentials" });
    }
  } catch (err) {
    console.error("Error querying Azure SQL:", err);
    res.status(500).send("Error querying database");
  }
});

app.get("/", async (req, res) => {
  return res.json({ success: "api connected" });
});

const port = process.env.PORT || 3001;
app.listen(port, () => {
  console.log(`\n\nServer is running on port ${port}`);
});
