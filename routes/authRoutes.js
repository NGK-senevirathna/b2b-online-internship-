const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// Temporary in-memory database (Low RAM & Fast)
const users = [];

// Register User
const register = async (req, res) => {
    try {
        const { username, password, role } = req.body;
        
        const existingUser = users.find(u => u.username === username);
        if (existingUser) return res.status(400).json({ message: "User already exists!" });

        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = { id: users.length + 1, username, password: hashedPassword, role: role || 'Buyer' };
        
        users.push(newUser);
        res.status(201).json({ message: "User registered successfully!", userId: newUser.id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// Login User
const login = async (req, res) => {
    try {
        const { username, password } = req.body;
        
        const user = users.find(u => u.username === username);
        if (!user) return res.status(404).json({ message: "User not found!" });

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(400).json({ message: "Invalid credentials!" });

        const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, process.env.JWT_SECRET, { expiresIn: '1h' });
        
        res.json({ message: "Login successful", token });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

module.exports = { register, login };