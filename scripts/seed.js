'use strict';

/**
 * Loads a small demo dataset (one Admin, one Seller, one Buyer and sample products).
 * - Refuses to run when NODE_ENV=production unless ALLOW_SEED=true.
 * - Does nothing if the demo accounts already exist.
 * - Uses SEED_PASSWORD when set, otherwise generates a random password and prints it once.
 */

require('dotenv').config();

const bcrypt = require('bcryptjs');
const { randomBytes } = require('node:crypto');
const userModel = require('../models/userModel');
const productService = require('../services/productService');
const { closePool, checkConnection } = require('../config/database');

const DEMO_PRODUCTS = [
    { sku: 'GLV-NIT-L', name: 'Nitrile Work Gloves (Box of 100, L)', description: 'Powder-free nitrile gloves for general handling.', priceCents: 1850, stockQuantity: 240 },
    { sku: 'GLV-NIT-M', name: 'Nitrile Work Gloves (Box of 100, M)', description: 'Powder-free nitrile gloves for general handling.', priceCents: 1850, stockQuantity: 180 },
    { sku: 'TAP-PKG-48', name: 'Packing Tape 48mm x 100m (Case of 36)', description: 'Clear acrylic packing tape.', priceCents: 4200, stockQuantity: 60 },
    { sku: 'BOX-CRG-M', name: 'Corrugated Shipping Box, Medium (Pack of 25)', description: '400 x 300 x 250 mm, double wall.', priceCents: 3150, stockQuantity: 90 },
    { sku: 'LBL-THR-4X6', name: 'Thermal Shipping Labels 4x6 (Roll of 500)', description: 'Direct thermal labels, 25 mm core.', priceCents: 1299, stockQuantity: 4 },
    { sku: 'PLT-WRP-500', name: 'Pallet Stretch Wrap 500mm (Case of 4)', description: 'Hand-grade stretch film.', priceCents: 5600, stockQuantity: 35 },
    { sku: 'SAF-VST-HV', name: 'High-Visibility Safety Vest (Pack of 10)', description: 'EN ISO 20471 class 2.', priceCents: 6890, stockQuantity: 0 },
    { sku: 'CLN-WIP-IND', name: 'Industrial Cleaning Wipes (Tub of 800)', description: 'Solvent-free heavy-duty wipes.', priceCents: 2475, stockQuantity: 75 }
];

/**
 * Creates the demo data.
 * @returns {Promise<void>} Resolves after seeding.
 */
async function seed() {
    if (process.env.NODE_ENV === 'production' && process.env.ALLOW_SEED !== 'true') {
        throw new Error('Refusing to seed demo data in production. Set ALLOW_SEED=true to override.');
    }
    await checkConnection();

    const password = process.env.SEED_PASSWORD || randomBytes(12).toString('base64url');
    if (password.length < 8 || Buffer.byteLength(password, 'utf8') > 72) {
        throw new Error('SEED_PASSWORD must be 8-72 bytes.');
    }
    const passwordHash = await bcrypt.hash(password, 12);

    const accounts = [
        { username: 'demo.admin', email: 'admin@demo.example', role: 'Admin' },
        { username: 'demo.seller', email: 'seller@demo.example', role: 'Seller' },
        { username: 'demo.buyer', email: 'buyer@demo.example', role: 'Buyer' }
    ];
    if (await userModel.findByUsername(accounts[0].username)) {
        console.info('Demo data already present; nothing to do.');
        return;
    }

    const created = {};
    for (const account of accounts) {
        created[account.role] = await userModel.createUser({ ...account, passwordHash });
    }
    for (const product of DEMO_PRODUCTS) {
        await productService.createProduct({ user: created.Seller, ip: 'seed-script' }, product);
    }

    console.info('Demo data created.');
    console.info('Accounts: demo.admin, demo.seller, demo.buyer');
    console.info(process.env.SEED_PASSWORD
        ? 'Password: the value of SEED_PASSWORD.'
        : `Password (shown once): ${password}`);
}

seed()
    .catch((error) => {
        console.error('Seeding failed.', error.message);
        process.exitCode = 1;
    })
    .finally(() => closePool());
