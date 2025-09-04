import express from 'express';
import cors from 'cors';
import { GoogleGenAI, Type } from "@google/genai";
import crypto from 'crypto';
import pg from 'pg';
import FormData from 'form-data';
import OpenAI from 'openai';
import sharp from 'sharp';
import { Readable } from 'stream';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { parseString } from 'xml2js';

const { Pool } = pg;

const app = express();
const port = process.env.PORT || 3001;

// --- Database Configuration ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

console.log('🚀 Blog MONKEE Backend Server Starting...');

// --- AI Configuration ---
const gemini = new GoogleGenAI(process.env.API_KEY);
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// --- WordPress Configuration ---
const WORDPRESS_CONFIG = {
  url: process.env.WORDPRESS_URL,
  username: process.env.WORDPRESS_USERNAME,
  password: process.env.WORDPRESS_PASSWORD,
  enabled: !!(process.env.WORDPRESS_URL && process.env.WORDPRESS_USERNAME && process.env.WORDPRESS_PASSWORD)
};

console.log(`📝 WordPress integration: ${WORDPRESS_CONFIG.enabled ? 'ENABLED' : 'DISABLED'}`);

async function initializeDb() {
  const client = await pool.connect();
  try {
    // Create clients table
    await client.query(`
      CREATE TABLE IF NOT EXISTS clients (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        website_url TEXT NOT NULL,
        xml_sitemap_url TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create sitemap_urls table
    await client.query(`
      CREATE TABLE IF NOT EXISTS sitemap_urls (
        id SERIAL PRIMARY KEY,
        client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
        url TEXT NOT NULL,
        last_modified TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create used_topics table
    await client.query(`
      CREATE TABLE IF NOT EXISTS used_topics (
        id SERIAL PRIMARY KEY,
        client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
        topic TEXT NOT NULL,
        used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('✅ Database tables initialized successfully');
  } catch (error) {
    console.error('❌ Database initialization error:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Initialize database on startup
initializeDb().catch(console.error);

app.use(cors());
app.use(express.json());

// --- Health Check ---
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    service: 'Blog MONKEE Backend',
    timestamp: new Date().toISOString() 
  });
});

// --- Client Management Endpoints ---

// Get all clients
app.get('/api/clients', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM clients ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching clients:', error);
    res.status(500).json({ error: 'Failed to fetch clients' });
  }
});

// Create new client
app.post('/api/clients', async (req, res) => {
  const { name, websiteUrl, xmlSitemapUrl } = req.body;

  if (!name || !websiteUrl) {
    return res.status(400).json({ error: 'Name and website URL are required' });
  }

  try {
    const result = await pool.query(
      'INSERT INTO clients (name, website_url, xml_sitemap_url) VALUES ($1, $2, $3) RETURNING *',
      [name, websiteUrl, xmlSitemapUrl]
    );

    const newClient = result.rows[0];
    console.log(`✅ Created new client: ${newClient.name}`);

    res.status(201).json({
      success: true,
      message: 'Client created successfully',
      client: newClient
    });
  } catch (error) {
    console.error('Error creating client:', error);
    res.status(500).json({ error: 'Failed to create client' });
  }
});

// Update client
app.put('/api/clients/:id', async (req, res) => {
  const { id } = req.params;
  const { name, websiteUrl, xmlSitemapUrl } = req.body;

  try {
    const result = await pool.query(
      'UPDATE clients SET name = $1, website_url = $2, xml_sitemap_url = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $4 RETURNING *',
      [name, websiteUrl, xmlSitemapUrl, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Client not found' });
    }

    console.log(`✅ Updated client: ${result.rows[0].name}`);
    res.json({
      success: true,
      message: 'Client updated successfully',
      client: result.rows[0]
    });
  } catch (error) {
    console.error('Error updating client:', error);
    res.status(500).json({ error: 'Failed to update client' });
  }
});

// Delete client
app.delete('/api/clients/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query('DELETE FROM clients WHERE id = $1 RETURNING *', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Client not found' });
    }

    console.log(`✅ Deleted client: ${result.rows[0].name}`);
    res.json({
      success: true,
      message: 'Client deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting client:', error);
    res.status(500).json({ error: 'Failed to delete client' });
  }
});

// --- Content Generation Endpoints ---

// Generate blog content
app.post('/api/generate-blog', async (req, res) => {
  const { clientId, topic, mode = 'regular' } = req.body;

  if (!clientId || !topic) {
    return res.status(400).json({ error: 'Client ID and topic are required' });
  }

  try {
    // Get client data
    const clientResult = await pool.query('SELECT * FROM clients WHERE id = $1', [clientId]);
    if (clientResult.rows.length === 0) {
      return res.status(404).json({ error: 'Client not found' });
    }

    const client = clientResult.rows[0];
    console.log(`🎯 Generating blog for ${client.name}: "${topic}"`);

    // Generate content using AI
    const blogContent = await generateBlogContent(topic, client);

    // Store used topic
    await pool.query(
      'INSERT INTO used_topics (client_id, topic) VALUES ($1, $2)',
      [clientId, topic]
    );

    res.json({
      success: true,
      content: blogContent,
      client: client
    });

  } catch (error) {
    console.error('Error generating blog:', error);
    res.status(500).json({ error: 'Failed to generate blog content' });
  }
});

// --- AI Content Generation Functions ---

async function generateBlogContent(topic, client) {
  try {
    console.log(`🤖 Generating content for topic: "${topic}"`);

    // Generate blog content using Gemini
    const model = gemini.getGenerativeModel({ model: "gemini-2.0-flash-exp" });
    
    const prompt = `Write a comprehensive, SEO-optimized blog post about "${topic}" for a business website. 
    
    Requirements:
    - 1500-2000 words
    - Professional, engaging tone
    - Include relevant headings and subheadings
    - Add a compelling introduction and conclusion
    - Include practical tips and actionable advice
    - Write in a natural, human-like style
    - Avoid AI-sounding language
    - Include relevant keywords naturally
    - Structure with proper HTML formatting

    Format the response as clean HTML with proper heading tags (h2, h3), paragraphs, and lists.`;

    const result = await model.generateContent(prompt);
    const content = result.response.text();

    // Generate featured image
    const imageUrl = await generateFeaturedImage(topic);

    return {
      title: topic,
      content: content,
      featuredImage: imageUrl,
      excerpt: content.substring(0, 200) + '...',
      wordCount: content.split(' ').length
    };

  } catch (error) {
    console.error('Error generating blog content:', error);
    throw error;
  }
}

async function generateFeaturedImage(topic) {
  try {
    console.log(`🎨 Generating featured image for: "${topic}"`);

    const response = await openai.images.generate({
      model: "dall-e-3",
      prompt: `Professional photography style image representing "${topic}". High quality, realistic, business-appropriate, clean composition, natural lighting.`,
      size: "1024x1024",
      quality: "hd",
      n: 1,
    });

    return response.data[0].url;
  } catch (error) {
    console.error('Error generating featured image:', error);
    return null;
  }
}

// --- WordPress Integration ---

async function publishToWordPress(blogContent, client) {
  if (!WORDPRESS_CONFIG.enabled) {
    console.log('⚠️ WordPress integration disabled');
    return null;
  }

  try {
    console.log(`📝 Publishing to WordPress for: ${client.name}`);

    // Upload featured image if available
    let featuredImageId = null;
    if (blogContent.featuredImage) {
      featuredImageId = await uploadImageToWordPress(blogContent.featuredImage, client);
    }

    // Create post data
    const postData = {
      title: blogContent.title,
      content: blogContent.content,
      status: 'draft', // Save as draft for review
      excerpt: blogContent.excerpt,
      featured_media: featuredImageId
    };

    // Publish post
    const response = await axios.post(
      `${WORDPRESS_CONFIG.url}/wp-json/wp/v2/posts`,
      postData,
      {
        auth: {
          username: WORDPRESS_CONFIG.username,
          password: WORDPRESS_CONFIG.password
        }
      }
    );

    console.log(`✅ Published to WordPress: ${response.data.link}`);
    return response.data;

  } catch (error) {
    console.error('Error publishing to WordPress:', error);
    throw error;
  }
}

async function uploadImageToWordPress(imageUrl, client) {
  try {
    // Download image
    const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    const imageBuffer = Buffer.from(imageResponse.data);

    // Create form data
    const formData = new FormData();
    formData.append('file', imageBuffer, {
      filename: `${client.name}-${Date.now()}.jpg`,
      contentType: 'image/jpeg'
    });

    // Upload to WordPress
    const uploadResponse = await axios.post(
      `${WORDPRESS_CONFIG.url}/wp-json/wp/v2/media`,
      formData,
      {
        headers: {
          ...formData.getHeaders(),
          'Content-Disposition': `attachment; filename="${client.name}-${Date.now()}.jpg"`
        },
        auth: {
          username: WORDPRESS_CONFIG.username,
          password: WORDPRESS_CONFIG.password
        }
      }
    );

    return uploadResponse.data.id;
  } catch (error) {
    console.error('Error uploading image to WordPress:', error);
    return null;
  }
}

// --- Error Handling ---
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// --- Start Server ---
app.listen(port, () => {
  console.log(`🚀 Blog MONKEE Backend running on port ${port}`);
  console.log(`🌐 Health check: http://localhost:${port}/health`);
});
