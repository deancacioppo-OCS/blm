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

async function initializeDb() {
  const client = await pool.connect();
  try {
    // Create clients table
    await client.query(`
      CREATE TABLE IF NOT EXISTS clients (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        industry TEXT NOT NULL,
        "websiteUrl" TEXT,
        "uniqueValueProp" TEXT,
        "brandVoice" TEXT,
        "contentStrategy" TEXT,
        "sitemapUrl" TEXT,
        wp JSONB,
        "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Add sitemapUrl column if it doesn't exist (for existing databases)
    try {
      // Check if column exists first
      const columnCheck = await client.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'clients' AND column_name = 'sitemapUrl';
      `);
      
      if (columnCheck.rows.length === 0) {
        await client.query(`ALTER TABLE clients ADD COLUMN "sitemapUrl" TEXT;`);
        console.log('✓ sitemapUrl column added');
      } else {
        console.log('✓ sitemapUrl column already exists');
      }
    } catch (alterError) {
      console.log('Note: Could not add sitemapUrl column:', alterError.message);
    }
     // Check if sitemap_urls table exists and get its structure
    const tableCheck = await client.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'sitemap_urls' 
      ORDER BY ordinal_position;
    `);
    
    console.log('Current sitemap_urls table structure:', tableCheck.rows);

    // Create enhanced sitemap_urls table
    await client.query(`
      CREATE TABLE IF NOT EXISTS sitemap_urls (
        id SERIAL PRIMARY KEY,
        client_id TEXT NOT NULL,
        url TEXT NOT NULL,
        title TEXT,
        description TEXT,
        keywords TEXT,
        category TEXT,
        last_modified TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
        UNIQUE(client_id, url)
      );
    `);

    // Create topic external links table for real-time Google Search results
    await client.query(`
      CREATE TABLE IF NOT EXISTS topic_external_links (
        id SERIAL PRIMARY KEY,
        client_id TEXT NOT NULL,
        topic TEXT NOT NULL,
        url TEXT NOT NULL,
        title TEXT,
        domain TEXT,
        authority_score INTEGER DEFAULT 0,
        is_validated BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
        UNIQUE(client_id, topic, url)
      );
    `);

    // Add missing columns to existing sitemap_urls table
    const columnsToAdd = [
      { name: 'title', type: 'TEXT' },
      { name: 'description', type: 'TEXT' },
      { name: 'keywords', type: 'TEXT' },
      { name: 'category', type: 'TEXT' },
      { name: 'last_modified', type: 'TIMESTAMP WITH TIME ZONE' }
    ];

    for (const column of columnsToAdd) {
      try {
        // Check if column exists
        const columnCheck = await client.query(`
          SELECT column_name 
          FROM information_schema.columns 
          WHERE table_name = 'sitemap_urls' AND column_name = $1;
        `, [column.name]);
        
        if (columnCheck.rows.length === 0) {
          await client.query(`ALTER TABLE sitemap_urls ADD COLUMN ${column.name} ${column.type};`);
          console.log(`✓ Added column '${column.name}' to sitemap_urls table`);
        } else {
          console.log(`✓ Column '${column.name}' already exists in sitemap_urls table`);
        }
      } catch (alterError) {
        console.log(`❌ Could not add column '${column.name}':`, alterError.message);
      }
    }

    // Check if we still have missing columns after migration attempts
    const finalCheck = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'sitemap_urls';
    `);
    
    const currentColumns = finalCheck.rows.map(row => row.column_name);
    const requiredColumns = ['id', 'client_id', 'url', 'title', 'description', 'keywords', 'category', 'last_modified', 'createdAt'];
    const missingColumns = requiredColumns.filter(col => !currentColumns.includes(col) && !currentColumns.includes(`"${col}"`));
    
    console.log('Final column check - Current columns:', currentColumns);
    console.log('Final column check - Missing columns:', missingColumns);
    
    // If we're still missing critical columns, recreate the table
    if (missingColumns.length > 0) {
      console.log('⚠️ Critical columns still missing. Recreating sitemap_urls table...');
      
      // Backup existing data if any
      let backupData = [];
      try {
        const backup = await client.query('SELECT client_id, url FROM sitemap_urls');
        backupData = backup.rows;
        console.log(`📦 Backed up ${backupData.length} existing URLs`);
      } catch (backupError) {
        console.log('No existing data to backup');
      }
      
      // Drop and recreate table
      await client.query('DROP TABLE IF EXISTS sitemap_urls CASCADE');
      await client.query(`
        CREATE TABLE sitemap_urls (
          id SERIAL PRIMARY KEY,
          client_id TEXT NOT NULL,
          url TEXT NOT NULL,
          title TEXT,
          description TEXT,
          keywords TEXT,
          category TEXT,
          last_modified TIMESTAMP WITH TIME ZONE,
          "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
          UNIQUE(client_id, url)
        );
      `);
      
      // Restore basic data if we had any
      for (const row of backupData) {
        try {
          await client.query(
            'INSERT INTO sitemap_urls (client_id, url, "createdAt") VALUES ($1, $2, NOW())',
            [row.client_id, row.url]
          );
        } catch (restoreError) {
          console.log('Failed to restore row:', restoreError.message);
        }
      }
      
      console.log('✅ Successfully recreated sitemap_urls table with all columns');
    } else {
      console.log('✅ All required columns are present in sitemap_urls table');
    }
    // Create used_topics table
    await client.query(`
      CREATE TABLE IF NOT EXISTS used_topics (
        id SERIAL PRIMARY KEY,
        client_id TEXT NOT NULL,
        topic TEXT NOT NULL,
        FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
      );
    `);
    console.log('Database tables initialized successfully.');
  } catch (err) {
    console.error('Error initializing database tables:', err);
  } finally {
    client.release();
  }
}


// Middleware
app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? [
        'https://monkee.ai',
        'https://www.monkee.ai', 
        'https://blog-monkee-frontend.onrender.com',
        // Allow any Netlify domain (legacy support)
        /https:\/\/.*\.netlify\.app$/,
        // Allow any Netlify custom domain (legacy support)
        /https:\/\/.*\.netlify\.com$/
      ]
    : ['http://localhost:5173', 'http://localhost:3000']
}));
app.use(express.json());

// Initialize Gemini AI
if (!process.env.API_KEY) {
  throw new Error("API_KEY environment variable not set.");
}
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

// Initialize OpenAI for image generation
let openai = null;
try {
    if (!process.env.OPENAI_API_KEY) {
        console.warn('⚠️ OPENAI_API_KEY not set - image generation will be disabled');
    } else {
        openai = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY
        });
        console.log('✅ OpenAI initialized successfully for image generation');
    }
} catch (error) {
    console.error('❌ Failed to initialize OpenAI:', error.message);
}

// --- Helper Functions ---

// Helper function to generate FAQ HTML with JSON-LD schema
function generateFAQHTML(faqs) {
    if (!faqs || faqs.length === 0) {
        return '';
    }
    
    // Generate JSON-LD schema for SEO
    const faqSchema = {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        "mainEntity": faqs.map(faq => ({
            "@type": "Question",
            "name": faq.question,
            "acceptedAnswer": {
                "@type": "Answer",
                "text": faq.answer
            }
        }))
    };
    
    // Generate HTML structure
    const faqHTML = `
<section class="faq-section" style="margin-top: 3rem; padding: 2rem 0; border-top: 2px solid #e5e7eb;">
    <h2 style="font-size: 1.875rem; font-weight: bold; margin-bottom: 1.5rem; color: #1f2937;">Frequently Asked Questions</h2>
    <div class="faq-container">
        ${faqs.map(faq => `
        <div class="faq-item" style="margin-bottom: 1.5rem; padding: 1.5rem; border: 1px solid #e5e7eb; border-radius: 0.5rem; background-color: #f9fafb;">
            <h3 class="faq-question" style="font-size: 1.25rem; font-weight: 600; margin-bottom: 0.75rem; color: #374151;">${faq.question}</h3>
            <p class="faq-answer" style="color: #6b7280; line-height: 1.6;">${faq.answer}</p>
        </div>
        `).join('')}
    </div>
</section>

<script type="application/ld+json">
${JSON.stringify(faqSchema, null, 2)}
</script>`;
    
    return faqHTML;
}

// Helper function to generate Open Graph meta tags for social sharing
function generateOpenGraphTags(title, description, imageUrl, pageUrl, clientName) {
    if (!imageUrl) {
        return ''; // No Open Graph tags if no image
    }
    
    const openGraphHTML = `
<!-- Open Graph Meta Tags for Social Media Sharing -->
<meta property="og:title" content="${title}" />
<meta property="og:description" content="${description}" />
<meta property="og:image" content="${imageUrl}" />
<meta property="og:url" content="${pageUrl}" />
<meta property="og:type" content="article" />
<meta property="og:site_name" content="${clientName}" />
<meta property="article:author" content="${clientName}" />

<!-- Twitter Card Meta Tags -->
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${title}" />
<meta name="twitter:description" content="${description}" />
<meta name="twitter:image" content="${imageUrl}" />

<!-- Additional SEO Meta Tags -->
<meta name="description" content="${description}" />
<meta name="robots" content="index, follow" />
`;
    
    return openGraphHTML;
}

// REVOLUTIONARY: Real-time page discovery for intelligent deep linking
async function discoverRelevantPages(rootDomain, topic, industry) {
    try {
        console.log(`🔍 Starting real-time page discovery on ${rootDomain} for topic: "${topic}"`);
        
        // Step 1: Crawl the external site to discover pages
        const crawledPages = await crawlExternalSite(rootDomain, topic, industry);
        
        if (crawledPages.length === 0) {
            console.log(`⚠️ No pages discovered on ${rootDomain}, using root domain`);
            return [];
        }
        
        // Step 2: AI analyzes discovered pages for topic relevance
        console.log(`🧠 AI analyzing ${crawledPages.length} discovered pages for relevance to "${topic}"`);
        
        const relevancePrompt = `Analyze these pages from ${rootDomain} and identify the 2-3 most relevant to the topic "${topic}" in the ${industry} industry:

${crawledPages.map((page, index) => 
    `${index + 1}. URL: ${page.url}
    Title: ${page.title}
    Description: ${page.description}
    Content Preview: ${page.contentPreview}`
).join('\n\n')}

Requirements:
- Choose 2-3 pages most relevant to "${topic}"
- Prioritize pages with substantial, authoritative content
- Avoid generic pages (contact, about, home)
- Focus on informational, educational, or research content
- Return only the URLs of the most relevant pages

If no pages are highly relevant to "${topic}", return an empty list.`;

        const relevanceResponse = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: relevancePrompt,
            config: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        relevantUrls: {
                            type: Type.ARRAY,
                            items: { type: Type.STRING },
                            description: 'URLs of 2-3 most relevant pages'
                        },
                        reasoning: {
                            type: Type.STRING,
                            description: 'Brief explanation of why these pages are relevant'
                        }
                    },
                    required: ["relevantUrls", "reasoning"]
                }
            }
        });
        
        const relevanceData = JSON.parse(relevanceResponse.text);
        console.log(`🎯 AI found ${relevanceData.relevantUrls.length} relevant pages: ${relevanceData.reasoning}`);
        
        // Step 3: Validate discovered relevant pages
        const validatedDeepLinks = [];
        for (const url of relevanceData.relevantUrls) {
            try {
                const isValid = await validateUrlExists(url);
                if (isValid) {
                    validatedDeepLinks.push(url);
                    console.log(`✅ Validated deep link: ${url}`);
                } else {
                    console.log(`❌ Invalid deep link: ${url}`);
                }
            } catch (validationError) {
                console.log(`⚠️ Deep link validation failed: ${url}`);
            }
        }
        
        console.log(`🎉 Real-time discovery complete: ${validatedDeepLinks.length} validated deep links from ${rootDomain}`);
        return validatedDeepLinks;
        
    } catch (error) {
        console.error(`❌ Real-time page discovery failed for ${rootDomain}:`, error.message);
        return []; // Return empty array, will fallback to root domain
    }
}

// Helper function to crawl external site and discover pages
async function crawlExternalSite(rootDomain, topic, industry) {
    try {
        console.log(`🕷️ Crawling ${rootDomain} to discover pages...`);
        
        // Fetch the main page
        const response = await axios.get(rootDomain, {
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; BlogMonkee/1.0; +http://blogmonkee.com/bot)'
            }
        });
        
        const $ = cheerio.load(response.data);
        const discoveredPages = [];
        const processedUrls = new Set([rootDomain]);
        
        // Extract links from the main page
        $('a[href]').each((i, element) => {
            if (discoveredPages.length >= 15) return; // Limit for performance
            
            let href = $(element).attr('href');
            if (!href) return;
            
            // Convert relative URLs to absolute
            if (href.startsWith('/')) {
                href = rootDomain + href;
            } else if (!href.startsWith('http')) {
                href = rootDomain + '/' + href;
            }
            
            // Only process URLs from the same domain
            try {
                const urlObj = new URL(href);
                if (urlObj.hostname !== new URL(rootDomain).hostname) return;
            } catch (urlError) {
                return; // Skip invalid URLs
            }
            
            // Skip unwanted URLs
            if (href.includes('#') || href.includes('?') || 
                href.includes('.pdf') || href.includes('.jpg') || 
                href.includes('.png') || href.includes('mailto:') ||
                href.includes('tel:') || processedUrls.has(href)) {
                return;
            }
            
            processedUrls.add(href);
            
            // Extract page information
            const linkText = $(element).text().trim();
            const title = linkText || 'Page';
            
            discoveredPages.push({
                url: href,
                title: title,
                description: `Page about ${linkText}`,
                contentPreview: linkText
            });
        });
        
        console.log(`📄 Discovered ${discoveredPages.length} pages on ${rootDomain}`);
        
        // Enhanced page analysis for better content previews
        const enhancedPages = [];
        for (const page of discoveredPages.slice(0, 8)) { // Analyze top 8 pages
            try {
                console.log(`📖 Analyzing page content: ${page.url}`);
                const pageResponse = await axios.get(page.url, {
                    timeout: 8000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (compatible; BlogMonkee/1.0; +http://blogmonkee.com/bot)'
                    }
                });
                
                const page$ = cheerio.load(pageResponse.data);
                
                // Extract meaningful content
                const pageTitle = page$('title').text() || page$('h1').first().text() || page.title;
                const metaDescription = page$('meta[name="description"]').attr('content') || '';
                const firstParagraph = page$('p').first().text().substring(0, 200) || '';
                
                enhancedPages.push({
                    url: page.url,
                    title: pageTitle.trim(),
                    description: metaDescription || firstParagraph,
                    contentPreview: firstParagraph
                });
                
                console.log(`✅ Analyzed: ${pageTitle} - ${metaDescription.substring(0, 50)}...`);
                
            } catch (pageError) {
                console.log(`⚠️ Failed to analyze page ${page.url}: ${pageError.message}`);
                // Use basic page info if detailed analysis fails
                enhancedPages.push(page);
            }
        }
        
        return enhancedPages;
        
    } catch (crawlError) {
        console.error(`❌ External site crawling failed for ${rootDomain}:`, crawlError.message);
        return [];
    }
}

// Helper function to generate image in parallel using DALL-E 3
async function generateFeaturedImage(title, industry) {
    console.log(`🖼️ Starting parallel DALL-E 3 image generation for "${title}"`);
    
    // Check if OpenAI is available
    if (!openai) {
        console.warn(`⚠️ OpenAI not initialized - skipping image generation for "${title}"`);
        console.warn('💡 Please set OPENAI_API_KEY environment variable in Render dashboard');
        return null;
    }
    
    try {
        // Create a detailed, professional prompt for DALL-E 3
        const imagePrompt = `Create a PHOTOREALISTIC featured image for a blog post titled "${title}" in the ${industry} industry. 

CRITICAL REQUIREMENTS - PHOTOREALISTIC STYLE:
- PHOTOREALISTIC photography style - no illustrations, cartoons, or artistic renderings
- Real-world photography aesthetic with natural lighting and textures
- High-definition, crisp detail that looks like a professional photograph
- NO TEXT or very minimal text in the image
- Authentic, believable scenes and objects
- Professional camera quality with proper depth of field
- Natural colors and realistic materials/surfaces

VISUAL CONTENT:
- Visually represent the title/topic through real objects, people, or environments
- Use actual business settings, real equipment, or genuine scenarios
- Professional quality suitable for a blog header
- Clean composition with landscape orientation
- Appropriate for ${industry} industry content
- Focus on realistic imagery that tells the story without words

PHOTOGRAPHY STYLE:
- Shot with professional camera equipment
- Natural or professional studio lighting
- Sharp focus with realistic depth of field
- Authentic textures and materials
- Real-world environments and settings
- High-resolution photographic quality

The image should look like a genuine photograph taken by a professional photographer, communicating the essence of "${title}" through photorealistic visual elements.`;

        // Generate image using OpenAI DALL-E 3 (standard size)
        const response = await openai.images.generate({
            model: "dall-e-3",
            prompt: imagePrompt,
            n: 1,
            size: "1024x1024", // Standard size, will be resized to landscape
            quality: "hd", // HD quality for enhanced photorealism
            response_format: "b64_json"
        });
        
        if (!response.data || !response.data[0] || !response.data[0].b64_json) {
            throw new Error('No image data returned from DALL-E 3');
        }

        // Process and compress the image
        const originalImageBuffer = Buffer.from(response.data[0].b64_json, 'base64');
        
        // Resize to landscape format (1400x800) and compress
        const processedImageBuffer = await sharp(originalImageBuffer)
            .resize(1400, 800, { 
                fit: 'cover', 
                position: 'center' 
            })
            .jpeg({ 
                quality: 85, // Good quality with compression
                progressive: true 
            })
            .toBuffer();

        const imageBase64 = processedImageBuffer.toString('base64');
        
        // Generate SEO-friendly ALT text that describes the visual content
        const altText = `Professional ${industry} featured image visually representing "${title}" through symbolic imagery and modern design elements, no text overlay`;
        
        console.log(`✅ DALL-E 3 image generation completed for "${title}"`);
        
        return {
            imageBase64,
            altText,
            description: `Featured image for blog post: ${title}`,
            specifications: `Professional ${industry} industry image, 1400x800px, compressed JPEG, landscape orientation`
        };
        
    } catch (error) {
        console.error(`❌ DALL-E 3 image generation failed for "${title}":`, error.message);
        throw error;
    }
}

async function uploadImageToWordPress(imageBase64, filename, altText, client) {
    console.log(`📤 Starting WordPress image upload: ${filename}`);
    
    try {
        // Convert base64 to buffer
        const imageBuffer = Buffer.from(imageBase64, 'base64');
        console.log(`📊 Image buffer size: ${imageBuffer.length} bytes`);
        
        // Use direct binary upload (more reliable than FormData for WordPress)
        const uploadUrl = `${client.wp.url.replace(/\/$/, '')}/wp-json/wp/v2/media`;
        
        console.log(`🔗 Upload URL: ${uploadUrl}`);
        console.log(`📋 Using direct binary upload method (not FormData)`);
        
        const uploadResponse = await fetch(uploadUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${Buffer.from(`${client.wp.username}:${client.wp.appPassword}`).toString('base64')}`,
                'Content-Type': 'image/jpeg',
                'Content-Disposition': `attachment; filename="${filename}"`,
                'Cache-Control': 'no-cache'
            },
            body: imageBuffer  // Send raw buffer directly
        });
        
        console.log(`📊 Upload response status: ${uploadResponse.status}`);
        
        if (!uploadResponse.ok) {
            const errorText = await uploadResponse.text();
            console.error(`❌ WordPress upload error response:`, errorText);
            throw new Error(`WordPress media upload failed: ${uploadResponse.status} - ${errorText}`);
        }
        
        const mediaData = await uploadResponse.json();
        console.log(`✅ WordPress upload successful:`, {
            id: mediaData.id,
            url: mediaData.source_url,
            title: mediaData.title?.rendered
        });
        
        // Update ALT text if provided
        if (altText) {
            const updateUrl = `${client.wp.url.replace(/\/$/, '')}/wp-json/wp/v2/media/${mediaData.id}`;
            await fetch(updateUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Basic ${Buffer.from(`${client.wp.username}:${client.wp.appPassword}`).toString('base64')}`
                },
                body: JSON.stringify({
                    alt_text: altText
                })
            });
        }
        
        return {
            id: mediaData.id,
            url: mediaData.source_url,
            altText: altText
        };
        
    } catch (error) {
        console.error('Error uploading image to WordPress:', error);
        throw error;
    }
}

function validateInternalLinks(content, validLinks) {
    if (!validLinks.length) return { valid: true, message: 'No internal links to validate' };
    
    const validUrls = validLinks.map(link => link.url);
    
    // Extract all internal links (not external ones with target="_blank")
    const internalLinkRegex = /<a\s+[^>]*href\s*=\s*["']([^"']+)["'][^>]*(?!.*target\s*=\s*["']_blank["'])[^>]*>(.*?)<\/a>/gi;
    const internalLinks = [];
    let match;
    
    while ((match = internalLinkRegex.exec(content)) !== null) {
        const url = match[1];
        const anchorText = match[2];
        
        // Only process internal links (not external with http/https)
        if (!url.includes('http://') && !url.includes('https://') && !url.includes('mailto:') && !url.includes('tel:')) {
            internalLinks.push({ url, anchorText });
        }
    }
    
    console.log(`📊 Found ${internalLinks.length} internal links`);
    
    // Check for invalid URLs
    const invalidLinks = internalLinks.filter(link => !validUrls.includes(link.url));
    
    // Check for duplicate links to the same URL
    const urlCounts = {};
    internalLinks.forEach(link => {
        urlCounts[link.url] = (urlCounts[link.url] || 0) + 1;
    });
    
    const duplicateUrls = Object.keys(urlCounts).filter(url => urlCounts[url] > 1);
    
    // Log each internal link with quality assessment
    internalLinks.forEach((link, index) => {
        const isDuplicate = duplicateUrls.includes(link.url);
        const isValid = validUrls.includes(link.url);
        const isHomepage = link.url === '/' || link.url === '' || link.url.endsWith('/');
        
        let status = '[VALID]';
        if (!isValid) status = '[INVALID URL]';
        else if (isDuplicate) status = '[DUPLICATE]';
        else if (isHomepage) status = '[HOMEPAGE LINK - AVOID]';
        
        console.log(`🔗 Internal Link ${index + 1}: "${link.anchorText}" → ${link.url} ${status}`);
        
        if (isHomepage) {
            console.warn(`⚠️ Homepage link detected: "${link.anchorText}" → ${link.url}`);
            console.warn(`💡 Avoid linking to homepage unless absolutely necessary`);
        }
    });
    
    // Provide warnings and feedback
    if (duplicateUrls.length > 0) {
        console.warn(`⚠️ Duplicate internal links found - multiple links to same URLs:`, duplicateUrls);
        console.warn(`💡 Rule: Maximum ONE internal link per target page/blog`);
    }
    
    if (invalidLinks.length > 0) {
        console.error('❌ Invalid internal links found:', invalidLinks.map(l => l.url));
        console.log('✅ Valid internal links available:', validUrls);
    }
    
    if (internalLinks.length < 2) {
        console.warn(`⚠️ Only ${internalLinks.length} internal links found - should be 2-6 contextually relevant links`);
    } else if (internalLinks.length > 6) {
        console.warn(`⚠️ ${internalLinks.length} internal links found - maximum should be 6 to avoid over-linking`);
    }
    
    const hasErrors = invalidLinks.length > 0;
    const hasWarnings = duplicateUrls.length > 0;
    
    if (!hasErrors && !hasWarnings) {
        console.log('✅ All internal links are valid and follow best practices');
    }
    
    return {
        valid: !hasErrors,
        invalidLinks: invalidLinks.map(l => l.url),
        duplicateUrls: duplicateUrls,
        linkCount: internalLinks.length,
        message: hasErrors ? `Invalid links found: ${invalidLinks.map(l => l.url).join(', ')}` : 
                hasWarnings ? `Duplicate links found: ${duplicateUrls.join(', ')}` : 
                'All internal links are valid'
    };
}

// Helper function to create content style context from scraped site
function createContentStyleContext(internalLinks) {
    if (!internalLinks || internalLinks.length === 0) {
        return '\nNo existing content style reference available.';
    }
    
    const titles = internalLinks.filter(link => link.title).slice(0, 10);
    const categories = [...new Set(internalLinks.map(link => link.category).filter(Boolean))];
    
    return `
EXISTING CONTENT STYLE REFERENCE (match this tone and approach):
${titles.map((link, index) => `${index + 1}. "${link.title}"`).join('\n')}

Content Categories on Site: ${categories.join(', ')}

WRITING STYLE INSTRUCTIONS:
- Match the tone and style of the existing content titles above
- Write naturally and conversationally, avoiding overly promotional language
- Use clear, direct language without excessive adjectives or adverbs
- AVOID these AI-sounding phrases: "comprehensive solutions," "cutting-edge," "seamless," "revolutionary," "game-changing," "innovative," "state-of-the-art," "world-class," "industry-leading"
- AVOID overused adverbs: "seamlessly," "effortlessly," "significantly," "dramatically," "substantially," "comprehensively"
- Write as a knowledgeable professional, not a marketing copywriter
- Use active voice and concrete examples rather than abstract concepts
- Keep sentences varied in length - mix short punchy sentences with longer explanatory ones
- Avoid overuse of superlatives (best, most, ultimate, perfect, incredible, amazing, outstanding)
- Use specific facts and numbers instead of vague claims
- Write like a human expert sharing practical knowledge, not an AI trying to impress
`;
}

// ENHANCED: Curated verified external links to prevent 404 errors
function getVerifiedExternalLinks(industry) {
    const verifiedLinks = {
        'insurance': [
            'https://www.naic.org',
            'https://www.iii.org',
            'https://www.iii.org/fact-statistic/facts-statistics-auto-insurance',
            'https://www.ambest.com',
            'https://www.insurancejournal.com',
            'https://www.propertycasualty360.com',
            'https://www.census.gov/topics/housing.html',
            'https://www.bls.gov/ooh/business-and-financial/insurance-sales-agents.htm'
        ],
        'real estate': [
            'https://www.nar.realtor',
            'https://www.realtor.com',
            'https://www.census.gov/topics/housing.html',
            'https://www.hud.gov',
            'https://www.freddiemac.com/research',
            'https://www.fanniemae.com/research-and-insights',
            'https://www.zillow.com/research'
        ],
        'digital marketing': [
            'https://blog.hubspot.com',
            'https://searchengineland.com',
            'https://www.searchenginejournal.com',
            'https://contentmarketinginstitute.com',
            'https://support.google.com/google-ads',
            'https://developers.facebook.com/docs/marketing-apis'
        ],
        'roofing': [
            'https://www.nrca.net',
            'https://www.roofingcontractor.com',
            'https://www.iccsafe.org',
            'https://www.nist.gov',
            'https://www.epa.gov',
            'https://www.energystar.gov',
            'https://www.ready.gov'
        ],
        'healthcare': [
            'https://www.cdc.gov',
            'https://www.who.int',
            'https://www.nih.gov',
            'https://www.ama-assn.org',
            'https://www.hfma.org'
        ],
        'general': [
            'https://www.bbc.com',
            'https://www.cnbc.com',
            'https://www.cdc.gov',
            'https://www.census.gov',
            'https://www.ready.gov',
            'https://en.wikipedia.org'
        ]
    };

    const industryKey = industry.toLowerCase().replace(/[^a-z\s]/g, '').trim();
    const industryLinks = verifiedLinks[industryKey] || [];
    const generalLinks = verifiedLinks['general'];
    
    return [...industryLinks, ...generalLinks];
}

// Helper function to get industry-specific authoritative sources (legacy - keeping for compatibility)
function getIndustryAuthoritativeSources(industry) {
    const sources = {
        'insurance': [
            'National Association of Insurance Commissioners (naic.org)',
            'Insurance Information Institute (iii.org)',
            'A.M. Best Company (ambest.com)',
            'Insurance Journal (insurancejournal.com)',
            'PropertyCasualty360 (propertycasualty360.com)'
        ],
        'digital marketing': [
            'Search Engine Journal (searchenginejournal.com)',
            'Marketing Land (marketingland.com)',
            'HubSpot Blog (blog.hubspot.com)',
            'Content Marketing Institute (contentmarketinginstitute.com)',
            'Google Ads Help (support.google.com/google-ads)'
        ],
        'roofing': [
            'National Roofing Contractors Association (nrca.net)',
            'Roofing Contractor Magazine (roofingcontractor.com)',
            'International Building Code (iccsafe.org)',
            'OSHA (osha.gov)',
            'National Institute for Standards and Technology (nist.gov)'
        ],
        'healthcare': [
            'Centers for Disease Control and Prevention (cdc.gov)',
            'World Health Organization (who.int)',
            'National Institutes of Health (nih.gov)',
            'American Medical Association (ama-assn.org)',
            'Healthcare Financial Management Association (hfma.org)'
        ],
        'real estate': [
            'National Association of Realtors (nar.realtor)',
            'Realtor.com (realtor.com)',
            'U.S. Census Bureau (census.gov)',
            'Federal Housing Administration (hud.gov)',
            'Mortgage Bankers Association (mba.org)'
        ],
        'technology': [
            'TechCrunch (techcrunch.com)',
            'Wired (wired.com)',
            'IEEE (ieee.org)',
            'MIT Technology Review (technologyreview.com)',
            'Stack Overflow (stackoverflow.com)'
        ],
        'finance': [
            'Securities and Exchange Commission (sec.gov)',
            'Federal Reserve (federalreserve.gov)',
            'Investopedia (investopedia.com)',
            'Bloomberg (bloomberg.com)',
            'Financial Times (ft.com)'
        ],
        'general': [
            'Wikipedia (en.wikipedia.org)',
            'Reuters (reuters.com)',
            'BBC News (bbc.com/news)',
            'Wall Street Journal (wsj.com)',
            'Associated Press (apnews.com)'
        ]
    };
    
    const industryKey = industry.toLowerCase();
    return sources[industryKey] || sources['general'];
}

// Helper function to replace URL templates with actual URLs (Option 2: Template-Based)
function replaceUrlTemplatesWithReal(content, validLinks) {
    if (!validLinks || validLinks.length === 0) {
        console.log('🔗 No valid links available for template replacement');
        return content;
    }
    
    console.log('🔧 Starting template-based URL replacement...');
    let processedContent = content;
    let replacements = [];
    
    // Replace each template with corresponding real URL
    validLinks.forEach((link, index) => {
        const template = `{{LINK_${index + 1}}}`;
        const linkCount = (content.match(new RegExp(template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
        
        if (linkCount > 0) {
            processedContent = processedContent.replace(new RegExp(template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), link.url);
            replacements.push({
                template: template,
                url: link.url,
                title: link.title,
                count: linkCount
            });
            console.log(`🔄 REPLACED: "${template}" → "${link.url}" (${linkCount} times) for "${link.title}"`);
        }
    });
    
    console.log(`🎯 Template Replacement Summary: ${replacements.length} templates replaced`);
    return processedContent;
}

// ENHANCED: Real-time URL validation to prevent 404 errors
async function validateUrlExists(url) {
    try {
        console.log(`🔍 Validating URL: ${url}`);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);
        
        const response = await fetch(url, { 
            method: 'HEAD',
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; BlogMonkee/1.0; +http://blogmonkee.com/bot)'
            }
        });
        
        clearTimeout(timeoutId);
        const isValid = response.ok && response.status < 400;
        console.log(`${isValid ? '✅' : '❌'} URL validation: ${url} → ${response.status}`);
        return isValid;
        
    } catch (error) {
        console.log(`❌ URL validation failed: ${url} → ${error.message}`);
        return false;
    }
}

// MANDATORY: Validate external links with real-time URL checking
async function validateExternalLinks(content) {
    console.log('🔗 Validating external links in content...');
    
    // Extract external links with target="_blank"
    const externalLinkRegex = /<a\s+[^>]*href\s*=\s*["']([^"']+)["'][^>]*target\s*=\s*["']_blank["'][^>]*>(.*?)<\/a>/gi;
    const externalLinks = [];
    let match;
    
    while ((match = externalLinkRegex.exec(content)) !== null) {
        const url = match[1];
        const anchorText = match[2];
        
        // Only process external links (with http/https)
        if (url.includes('http://') || url.includes('https://')) {
            externalLinks.push({ url, anchorText });
        } else {
            console.log(`⚠️ Invalid external link found: ${url}`);
        }
    }
    
    console.log(`📊 Found ${externalLinks.length} external links`);
    
    // MANDATORY: Require minimum 2 external links
    if (externalLinks.length < 2) {
        console.error(`❌ MANDATORY EXTERNAL LINKS MISSING: Only ${externalLinks.length} external links found - MINIMUM 2 required`);
        throw new Error(`Content validation failed: Must include at least 2 external links, found only ${externalLinks.length}`);
    } else if (externalLinks.length > 8) {
        console.warn(`⚠️ ${externalLinks.length} external links found - maximum should be 8`);
    } else {
        console.log(`✅ External link count is optimal: ${externalLinks.length} links`);
    }
    
    // Real-time URL validation for all external links
    console.log('🌐 Starting real-time URL validation...');
    const validationResults = [];
    
    for (const link of externalLinks) {
        const isValid = await validateUrlExists(link.url);
        validationResults.push({
            url: link.url,
            anchorText: link.anchorText,
            isValid: isValid
        });
        
        if (!isValid) {
            console.error(`❌ BROKEN LINK DETECTED: "${link.anchorText}" → ${link.url}`);
        }
    }
    
    // Check if any links are broken
    const brokenLinks = validationResults.filter(result => !result.isValid);
    if (brokenLinks.length > 0) {
        console.error(`❌ CONTENT VALIDATION FAILED: ${brokenLinks.length} broken external links detected`);
        brokenLinks.forEach(link => {
            console.error(`   💔 Broken: "${link.anchorText}" → ${link.url}`);
        });
        throw new Error(`Content validation failed: ${brokenLinks.length} external links are broken or inaccessible`);
    }
    
    // Analyze link quality and legitimacy
    let wikipediaCount = 0;
    
    validationResults.forEach((result, index) => {
        const url = result.url.toLowerCase();
        let linkQuality = 'unknown';
        
        if (url.includes('wikipedia.org')) {
            wikipediaCount++;
            linkQuality = 'Wikipedia (should be last resort only)';
        } else if (url.includes('.gov')) {
            linkQuality = 'Government site (highly authoritative)';
        } else if (url.includes('.edu')) {
            linkQuality = 'Educational institution (academic source)';
        } else if (url.includes('reuters.com') || url.includes('bbc.com') || url.includes('wsj.com')) {
            linkQuality = 'Major news publication (credible)';
        } else if (url.includes('naic.org') || url.includes('iii.org') || url.includes('nrca.net') || url.includes('osha.gov')) {
            linkQuality = 'Industry association (excellent choice)';
        } else {
            linkQuality = 'Other source (verify legitimacy)';
        }
        
        const validationStatus = result.isValid ? '[WORKING ✅]' : '[BROKEN ❌]';
        console.log(`🔗 External Link ${index + 1}: "${result.anchorText}" → ${result.url} [${linkQuality}] ${validationStatus}`);
    });
    
    // Warn about Wikipedia overuse
    if (wikipediaCount > 1) {
        console.warn(`⚠️ Too many Wikipedia links (${wikipediaCount}) - Wikipedia should be last resort only`);
        console.warn(`💡 Prioritize industry-specific authoritative sources instead`);
    } else if (wikipediaCount === 1 && externalLinks.length <= 3) {
        console.warn(`⚠️ Wikipedia used but better industry sources may be available`);
    }
    
    console.log(`✅ All ${externalLinks.length} external links validated and working`);
    return externalLinks;
}

// --- Web Crawling and Sitemap Functions ---

// ENHANCED: Generate unique topic avoiding duplicates
async function generateUniqueTopicForClient(clientId, client) {
    try {
        // Get existing blog topics to avoid duplication
        const existingTopics = await pool.query(`
            SELECT title, url, description, category
            FROM sitemap_urls 
            WHERE client_id = $1 
            AND title IS NOT NULL 
            AND (category = 'blog' OR url LIKE '%blog%' OR url LIKE '%post%')
            ORDER BY "createdAt" DESC
            LIMIT 20
        `, [clientId]);
        
        console.log(`📚 Found ${existingTopics.rows.length} existing blog topics for deduplication check`);
        
        // Create context of existing topics for Gemini
        const existingTopicsContext = existingTopics.rows.length > 0 
            ? `\n\nIMPORTANT - AVOID DUPLICATE TOPICS:
            The following blog topics already exist for this client:
            ${existingTopics.rows.map((blog, index) => 
                `${index + 1}. "${blog.title}" (${blog.url})`
            ).join('\n')}
            
            🚫 DO NOT choose topics that are too similar to the above existing blogs.
            
            ✅ EXCEPTIONS - You MAY choose a related topic if it's a SUPPORTING article that:
            - Provides a completely different angle or perspective
            - Goes deeper into a specific sub-topic or aspect
            - Addresses a different audience segment (beginners vs experts)
            - Updates information with new developments or trends
            - Covers a different geographic area or market segment
            
            Choose a FRESH, UNIQUE topic that adds genuine value without duplication.`
            : '\n\nNo existing blog topics found - you have complete freedom to choose any relevant topic.';

        const topicPrompt = `Using Google Search, find one current and highly relevant trending topic, news story, or popular question related to the '${client.industry}' industry.${existingTopicsContext}
        
        Provide only the topic name or headline. Do not add any extra formatting or quotation marks.`;
        
        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: topicPrompt,
            config: {
                tools: [{googleSearch: {}}],
            },
        });
        
        const topic = response.text.trim();
        const sources = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
        
        console.log(`✅ Generated unique topic: "${topic}" (avoiding ${existingTopics.rows.length} existing topics)`);

        // REVOLUTIONARY: Extract and validate Google Search URLs for topic-specific external links
        console.log(`🔍 Processing ${sources.length} Google Search sources for real-time external links`);
        const topicalUrls = [];

        for (const source of sources) {
            if (source.web && source.web.uri) {
                const url = source.web.uri;
                
                // CRITICAL FIX: Filter out Google redirect URLs that expire
                if (url.includes('grounding-api-redirect') || url.includes('vertexaisearch.cloud.google.com')) {
                    console.log(`🚫 Skipping Google redirect URL: ${url.substring(0, 80)}...`);
                    continue;
                }
                
                try {
                    // Real-time validation for actual destination URLs only
                    const isValid = await validateUrlExists(url);
                    if (isValid) {
                        const domain = new URL(url).hostname.toLowerCase();
                        
                        // Authority scoring system
                        let authorityScore = 0;
                        if (domain.includes('.gov')) authorityScore = 100;
                        else if (domain.includes('.edu')) authorityScore = 90;
                        else if (domain.includes('nrca.net') || domain.includes('osha.gov') || domain.includes('iccsafe.org')) authorityScore = 85;
                        else if (domain.includes('bbc.com') || domain.includes('cnbc.com') || domain.includes('cdc.gov')) authorityScore = 75;
                        else if (domain.includes('wikipedia.org')) authorityScore = 40;
                        else authorityScore = 60;
                        
                        // Store validated topical external link
                        await pool.query(
                            'INSERT INTO topic_external_links (client_id, topic, url, domain, authority_score, is_validated) VALUES ($1, $2, $3, $4, $5, TRUE) ON CONFLICT (client_id, topic, url) DO UPDATE SET authority_score = $5, is_validated = TRUE',
                            [clientId, topic, url, domain, authorityScore]
                        );
                        
                        topicalUrls.push({ url, domain, authorityScore });
                        console.log(`✅ Validated topical link: ${url} [Authority: ${authorityScore}]`);
                    } else {
                        console.log(`❌ Invalid topical link: ${url}`);
                    }
                } catch (error) {
                    console.log(`⚠️ Error validating topical URL ${url}:`, error.message);
                }
            }
        }

        // Sort by authority score
        topicalUrls.sort((a, b) => b.authorityScore - a.authorityScore);
        console.log(`🎯 Real-time topical external links: ${topicalUrls.length} validated URLs stored`);

        return { 
            topic, 
            sources, 
            existingTopicsCount: existingTopics.rows.length,
            topicalExternalLinks: topicalUrls.map(link => link.url)
        };
        
    } catch (error) {
        console.error('Error generating unique topic:', error.message);
        throw error;
    }
}

// CRITICAL: Client validation to prevent data bleedthrough
async function validateClientOwnership(clientId, operation) {
    try {
        const client = await pool.query('SELECT name, "websiteUrl" FROM clients WHERE id = $1', [clientId]);
        if (client.rows.length === 0) {
            throw new Error(`Invalid client ID: ${clientId}`);
        }
        console.log(`✅ ${operation} validated for client: ${client.rows[0].name} (${clientId})`);
        return client.rows[0];
    } catch (error) {
        console.error(`❌ Client validation failed for ${operation}:`, error.message);
        throw error;
    }
}

// CRITICAL: Domain validation to prevent cross-client URL contamination
async function validateUrlDomain(clientId, url, clientInfo = null) {
    try {
        if (!clientInfo) {
            const result = await pool.query('SELECT "websiteUrl", name FROM clients WHERE id = $1', [clientId]);
            if (result.rows.length === 0) {
                console.error(`❌ Client not found for domain validation: ${clientId}`);
                return false;
            }
            clientInfo = result.rows[0];
        }
        
        if (!clientInfo.websiteUrl) {
            console.warn(`⚠️ No website URL configured for client ${clientInfo.name}, skipping domain validation`);
            return true; // Allow if no domain configured
        }
        
        const clientDomain = new URL(clientInfo.websiteUrl).hostname.toLowerCase();
        const urlDomain = new URL(url).hostname.toLowerCase();
        
        if (clientDomain !== urlDomain) {
            console.error(`🚨 DOMAIN MISMATCH BLOCKED: Client "${clientInfo.name}" (${clientDomain}) attempted to store URL from ${urlDomain}: ${url}`);
            return false;
        }
        
        console.log(`✅ Domain validation passed: ${urlDomain} matches client ${clientInfo.name}`);
        return true;
        
    } catch (error) {
        console.error(`❌ Domain validation error:`, error.message);
        return false; // Fail safe - reject on error
    }
}

// Helper function to add new blog URL to sitemap database (for auto-update)
async function addBlogToSitemapDatabase(clientId, blogUrl, title, description = 'Generated blog post') {
    try {
        // CRITICAL: Validate client ownership first
        const clientInfo = await validateClientOwnership(clientId, 'Blog Auto-Update');
        
        // CRITICAL: Validate domain to prevent cross-client contamination
        const domainValid = await validateUrlDomain(clientId, blogUrl, clientInfo);
        if (!domainValid) {
            console.error(`🚨 BLOCKED: Attempted to add URL from wrong domain to client ${clientInfo.name}: ${blogUrl}`);
            return false;
        }
        
        // Convert full URL to relative path for consistency
        let relativePath;
        if (blogUrl.startsWith('http')) {
            const urlObj = new URL(blogUrl);
            relativePath = urlObj.pathname;
        } else {
            relativePath = blogUrl;
        }
        
        // Clean trailing slash
        if (relativePath !== '/' && relativePath.endsWith('/')) {
            relativePath = relativePath.replace(/\/$/, '');
        }
        
        // Add to sitemap database with validated client ID
        await pool.query(
            'INSERT INTO sitemap_urls (client_id, url, title, description, category, last_modified) VALUES ($1, $2, $3, $4, $5, NOW()) ON CONFLICT (client_id, url) DO UPDATE SET title = $3, description = $4, category = $5, last_modified = NOW()',
            [clientId, relativePath, title, description, 'blog']
        );
        
        console.log(`✅ Auto-update: Added "${title}" to sitemap database at ${relativePath} for client ${clientInfo.name}`);
        return true;
        
    } catch (error) {
        console.error('❌ Failed to auto-update sitemap database:', error.message);
        return false;
    }
}

// NEW: XML Sitemap Parser Function - Much faster and more comprehensive than AI crawling
async function parseXMLSitemapForClient(clientId, sitemapUrl) {
    try {
        console.log(`🗺️ PARSING XML SITEMAP: Fetching sitemap from ${sitemapUrl}`);
        
        // Fetch the XML sitemap
        const response = await axios.get(sitemapUrl, {
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; BlogMonkee/1.0; +http://blogmonkee.com/bot)'
            }
        });
        
        console.log(`📄 Sitemap fetched: ${response.data.length} characters`);
        
        // Parse XML using xml2js
        const parseXML = (xmlData) => {
            return new Promise((resolve, reject) => {
                parseString(xmlData, (err, result) => {
                    if (err) reject(err);
                    else resolve(result);
                });
            });
        };
        
        const parsedXML = await parseXML(response.data);
        
        // Extract URLs from sitemap
        let urls = [];
        if (parsedXML.urlset && parsedXML.urlset.url) {
            urls = parsedXML.urlset.url;
        } else if (parsedXML.sitemapindex && parsedXML.sitemapindex.sitemap) {
            // Handle sitemap index - parse each individual sitemap
            console.log(`🗂️ Found sitemap index with ${parsedXML.sitemapindex.sitemap.length} sitemaps`);
            
            for (const sitemap of parsedXML.sitemapindex.sitemap) {
                try {
                    const subSitemapUrl = sitemap.loc[0];
                    console.log(`📋 Parsing sub-sitemap: ${subSitemapUrl}`);
                    
                    const subResponse = await axios.get(subSitemapUrl, {
                        timeout: 15000,
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (compatible; BlogMonkee/1.0; +http://blogmonkee.com/bot)'
                        }
                    });
                    
                    const subParsedXML = await parseXML(subResponse.data);
                    if (subParsedXML.urlset && subParsedXML.urlset.url) {
                        urls = urls.concat(subParsedXML.urlset.url);
                    }
                } catch (subError) {
                    console.warn(`⚠️ Failed to parse sub-sitemap: ${subError.message}`);
                }
            }
        }
        
        console.log(`🔍 Found ${urls.length} URLs in sitemap(s)`);
        
        // Process and store URLs
        const processedUrls = [];
        let stored = 0;
        let skipped = 0;
        
        for (const urlEntry of urls) {
            try {
                const fullUrl = urlEntry.loc[0];
                const lastMod = urlEntry.lastmod ? urlEntry.lastmod[0] : null;
                const priority = urlEntry.priority ? parseFloat(urlEntry.priority[0]) : null;
                
                // Extract relative URL path
                const urlObj = new URL(fullUrl);
                let relativePath = urlObj.pathname;
                
                // Skip certain URLs
                if (relativePath.includes('.xml') || 
                    relativePath.includes('.pdf') || 
                    relativePath.includes('/wp-admin/') ||
                    relativePath.includes('/feed/') ||
                    relativePath.includes('?') ||
                    relativePath.includes('#')) {
                    skipped++;
                    continue;
                }
                
                // Clean and normalize the path
                if (relativePath === '' || relativePath === '/') {
                    relativePath = '/';
                } else {
                    relativePath = relativePath.replace(/\/$/, ''); // Remove trailing slash
                }
                
                // Get basic page info (title estimation from URL)
                const pathSegments = relativePath.split('/').filter(segment => segment);
                let estimatedTitle = '';
                
                if (relativePath === '/') {
                    estimatedTitle = 'Homepage';
                } else if (pathSegments.length > 0) {
                    // Convert URL slug to title
                    estimatedTitle = pathSegments[pathSegments.length - 1]
                        .replace(/-/g, ' ')
                        .replace(/\b\w/g, l => l.toUpperCase());
                }
                
                // CRITICAL: Validate domain before storing
                const domainValid = await validateUrlDomain(clientId, fullUrl);
                if (!domainValid) {
                    console.warn(`🚨 BLOCKED: Skipping cross-domain URL in sitemap: ${fullUrl}`);
                    skipped++;
                    continue;
                }
                
                // Store in database with domain validation passed
                await pool.query(`
                    INSERT INTO sitemap_urls (client_id, url, title, last_modified, "createdAt")
                    VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
                    ON CONFLICT (client_id, url) 
                    DO UPDATE SET 
                        title = EXCLUDED.title,
                        last_modified = EXCLUDED.last_modified,
                        "createdAt" = CURRENT_TIMESTAMP
                `, [clientId, relativePath, estimatedTitle, lastMod]);
                
                processedUrls.push({
                    url: relativePath,
                    title: estimatedTitle,
                    lastModified: lastMod,
                    priority: priority
                });
                
                stored++;
                
            } catch (urlError) {
                console.warn(`⚠️ Error processing URL: ${urlError.message}`);
                skipped++;
            }
        }
        
        console.log(`✅ XML SITEMAP PARSING COMPLETE:`);
        console.log(`   📊 Total URLs found: ${urls.length}`);
        console.log(`   💾 URLs stored: ${stored}`);
        console.log(`   ⏭️ URLs skipped: ${skipped}`);
        console.log(`   ⚡ Performance: Much faster than AI crawling!`);
        
        return {
            success: true,
            totalFound: urls.length,
            stored: stored,
            skipped: skipped,
            urls: processedUrls
        };
        
    } catch (error) {
        console.error(`❌ XML Sitemap parsing failed for ${sitemapUrl}:`, error.message);
        throw error;
    }
}

// LEGACY: AI-based crawling function (keeping for fallback)
async function crawlWebsiteForClient(clientId, websiteUrl) {
    try {
        console.log(`🕷️ REAL CRAWLING: Fetching actual website content for ${websiteUrl}`);
        
        // Actually fetch the website HTML
        const response = await axios.get(websiteUrl, {
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });
        
        const $ = cheerio.load(response.data);
        const crawledPages = [];
        const foundUrls = new Set();
        
        // Extract all internal links from the page
        $('a[href]').each((i, element) => {
            const href = $(element).attr('href');
            const text = $(element).text().trim();
            
            if (!href || !text) return;
            
            let cleanUrl = href;
            
            // Convert absolute URLs to relative
            if (href.startsWith(websiteUrl)) {
                cleanUrl = href.replace(websiteUrl, '');
            } else if (href.startsWith('http')) {
                // Skip external links
                return;
            }
            
            // Ensure starts with /
            if (!cleanUrl.startsWith('/')) {
                cleanUrl = '/' + cleanUrl;
            }
            
            // Skip unwanted URLs
            if (
                cleanUrl.includes('#') || 
                cleanUrl.includes('mailto:') || 
                cleanUrl.includes('tel:') ||
                cleanUrl.includes('.pdf') ||
                cleanUrl.includes('.jpg') ||
                cleanUrl.includes('.png') ||
                cleanUrl.includes('.gif') ||
                cleanUrl.length > 200 ||
                foundUrls.has(cleanUrl)
            ) {
                return;
            }
            
            foundUrls.add(cleanUrl);
            
            // Determine category based on URL patterns
            let category = 'other';
            if (cleanUrl.includes('/blog/') || cleanUrl.includes('/news/')) category = 'blog';
            else if (cleanUrl.includes('/service') || cleanUrl.includes('/product')) category = 'service';
            else if (cleanUrl.includes('/about')) category = 'about';
            else if (cleanUrl.includes('/resource') || cleanUrl.includes('/guide')) category = 'resource';
            
            crawledPages.push({
                url: cleanUrl,
                title: text.length > 100 ? text.substring(0, 100) + '...' : text,
                description: `Real page: ${text}`,
                category: category
            });
        });
        
        // Limit to 30 most relevant pages, prioritizing non-homepage links
        const filteredPages = crawledPages
            .filter(page => page.url !== '/' || crawledPages.length < 5) // Keep homepage only if we have few pages
            .slice(0, 30);
        
        console.log(`🎯 REAL CRAWL RESULTS: Found ${filteredPages.length} actual pages on ${websiteUrl}`);
        
        // Store the real crawled pages directly (they're already cleaned)
        console.log('📋 Storing actual website URLs in database');
        
        // Clear existing URLs for this client first
        await pool.query('DELETE FROM sitemap_urls WHERE client_id = $1', [clientId]);
        
        // Store the crawled pages in the database
        for (const page of filteredPages) {
            console.log(`✅ Storing real URL: ${page.url} - "${page.title}"`);
            try {
                await pool.query(
                    'INSERT INTO sitemap_urls (client_id, url, title, description, category, last_modified) VALUES ($1, $2, $3, $4, $5, NOW()) ON CONFLICT (client_id, url) DO UPDATE SET title = $3, description = $4, category = $5, last_modified = NOW()',
                    [clientId, page.url, page.title, page.description, page.category]
                );
            } catch (insertError) {
                console.log(`Failed to insert URL ${page.url}:`, insertError.message);
            }
        }
        
        console.log(`✅ REAL CRAWL SUCCESS: Stored ${filteredPages.length} actual URLs for client ${clientId}`);
        return filteredPages.length;
        
    } catch (error) {
        console.error('❌ Error in real website crawling:', error);
        console.error('🔧 Falling back to basic page structure...');
        
        // Fallback: create basic page structure
        const fallbackPages = [
            { url: '/', title: 'Homepage', description: 'Main homepage', category: 'other' },
            { url: '/about/', title: 'About Us', description: 'About page', category: 'about' },
            { url: '/contact/', title: 'Contact', description: 'Contact information', category: 'other' }
        ];
        
        // Clear existing URLs for this client first
        await pool.query('DELETE FROM sitemap_urls WHERE client_id = $1', [clientId]);
        
        // Store fallback pages
        for (const page of fallbackPages) {
            try {
                await pool.query(
                    'INSERT INTO sitemap_urls (client_id, url, title, description, category, last_modified) VALUES ($1, $2, $3, $4, $5, NOW()) ON CONFLICT (client_id, url) DO UPDATE SET title = $3, description = $4, category = $5, last_modified = NOW()',
                    [clientId, page.url, page.title, page.description, page.category]
                );
            } catch (insertError) {
                console.log(`Failed to insert URL ${page.url}:`, insertError.message);
            }
        }
        
        console.log(`⚠️ FALLBACK: Stored ${fallbackPages.length} basic URLs for client ${clientId}`);
        return fallbackPages.length;
    }
}

async function analyzeUrlsWithAI(clientId, urls) {
    try {
        const client = await pool.query('SELECT * FROM clients WHERE id = $1', [clientId]);
        if (client.rows.length === 0) return;
        
        const clientData = client.rows[0];
        
        // Analyze URLs in batches to extract titles and categorize
        const urlList = urls.map(u => u.url).join('\n');
        
        const prompt = `
            Analyze these URLs from a ${clientData.industry} website and extract likely page titles, descriptions, and categories for internal linking purposes:
            
            ${urlList}
            
            For each URL, provide:
            1. Likely page title (infer from URL structure)
            2. Brief description of what the page likely contains
            3. Category/topic (for grouping related content)
            4. Keywords that might be relevant for internal linking
            
            Focus on content that would be valuable for internal linking in blog posts.
        `;
        
        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: prompt,
            config: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        pages: {
                            type: Type.ARRAY,
                            items: {
                                type: Type.OBJECT,
                                properties: {
                                    url: { type: Type.STRING },
                                    title: { type: Type.STRING },
                                    description: { type: Type.STRING },
                                    category: { type: Type.STRING },
                                    keywords: { type: Type.STRING }
                                }
                            }
                        }
                    },
                    required: ["pages"]
                }
            }
        });
        
        const analysis = JSON.parse(response.text);
        
        // Update database with AI analysis
        for (const page of analysis.pages) {
            try {
                await pool.query(
                    'UPDATE sitemap_urls SET title = $1, description = $2, category = $3, keywords = $4 WHERE client_id = $5 AND url = $6',
                    [page.title, page.description, page.category, page.keywords, clientId, page.url]
                );
            } catch (updateError) {
                console.log(`Failed to update URL analysis for ${page.url}:`, updateError.message);
            }
        }
        
        console.log(`Analyzed ${analysis.pages.length} URLs with AI`);
    } catch (error) {
        console.error('Error analyzing URLs with AI:', error);
    }
}

// --- API Routes ---

// Health check endpoint for Render
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', message: 'Blog MONKEE Backend is running' });
});

// GET all clients
app.get('/api/clients', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM clients ORDER BY name ASC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

// GET a single client
app.get('/api/clients/:id', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM clients WHERE id = $1', [req.params.id]);
        if (result.rows.length > 0) {
            res.json(result.rows[0]);
        } else {
            res.status(404).send('Client not found');
        }
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

// CREATE a new client
app.post('/api/clients', async (req, res) => {
  const { name, industry, websiteUrl, sitemapUrl, uniqueValueProp, brandVoice, contentStrategy, wp } = req.body;
  const newClient = {
    id: crypto.randomUUID(),
    name, industry, websiteUrl, sitemapUrl, uniqueValueProp, brandVoice, contentStrategy, wp
  };
  try {
    const result = await pool.query(
      `INSERT INTO clients (id, name, industry, "websiteUrl", "sitemapUrl", "uniqueValueProp", "brandVoice", "contentStrategy", wp) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [newClient.id, newClient.name, newClient.industry, newClient.websiteUrl, newClient.sitemapUrl, newClient.uniqueValueProp, newClient.brandVoice, newClient.contentStrategy, newClient.wp]
    );
    
    // Crawl website for internal links if websiteUrl is provided
    if (websiteUrl) {
      try {
        console.log(`Starting website crawl for new client: ${name}`);
        await crawlWebsiteForClient(newClient.id, websiteUrl);
        console.log(`Website crawl completed for client: ${name}`);
      } catch (crawlError) {
        console.log(`Failed to crawl website for client ${name}:`, crawlError.message);
        // Don't fail client creation if crawling fails
      }
    }
    
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

// UPDATE a client
app.put('/api/clients/:id', async (req, res) => {
    const { name, industry, websiteUrl, sitemapUrl, uniqueValueProp, brandVoice, contentStrategy, wp } = req.body;
    try {
        // Get current client to compare websiteUrl and sitemapUrl
        const currentClient = await pool.query('SELECT "websiteUrl", "sitemapUrl" FROM clients WHERE id = $1', [req.params.id]);
        const currentWebsiteUrl = currentClient.rows[0]?.websiteUrl;
        const currentSitemapUrl = currentClient.rows[0]?.sitemapUrl;
        
        const result = await pool.query(
            `UPDATE clients SET 
             name = $1, industry = $2, "websiteUrl" = $3, "sitemapUrl" = $4, "uniqueValueProp" = $5, 
             "brandVoice" = $6, "contentStrategy" = $7, wp = $8, "updatedAt" = NOW()
             WHERE id = $9 RETURNING *`,
            [name, industry, websiteUrl, sitemapUrl, uniqueValueProp, brandVoice, contentStrategy, wp, req.params.id]
        );
        
        if (result.rows.length > 0) {
            // If website URL is provided and changed, crawl and store it
            if (websiteUrl && websiteUrl !== currentWebsiteUrl) {
                try {
                    console.log(`Website URL changed for client ${name}, starting crawl...`);
                    // Clear existing URLs for this client
                    await pool.query('DELETE FROM sitemap_urls WHERE client_id = $1', [req.params.id]);
                    // Crawl and store new website
                    await crawlWebsiteForClient(req.params.id, websiteUrl);
                    console.log(`Website crawl completed for client: ${name}`);
                } catch (crawlError) {
                    console.log(`Failed to crawl website for client ${name}:`, crawlError.message);
                }
            }
            
            // If sitemap URL is provided and changed, parse and store it
            if (sitemapUrl && sitemapUrl !== currentSitemapUrl) {
                try {
                    console.log(`Sitemap URL changed for client ${name}, starting XML sitemap parsing...`);
                    // Clear existing URLs for this client
                    await pool.query('DELETE FROM sitemap_urls WHERE client_id = $1', [req.params.id]);
                    // Parse and store new sitemap
                    await parseXMLSitemapForClient(req.params.id, sitemapUrl);
                    console.log(`XML sitemap parsing completed for client: ${name}`);
                } catch (sitemapError) {
                    console.log(`Failed to parse XML sitemap for client ${name}:`, sitemapError.message);
                }
            }
            
            res.json(result.rows[0]);
        } else {
            res.status(404).send('Client not found');
        }
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

// DELETE a client
app.delete('/api/clients/:id', async (req, res) => {
    try {
        const result = await pool.query('DELETE FROM clients WHERE id = $1', [req.params.id]);
        if (result.rowCount > 0) {
            res.status(204).send();
        } else {
            res.status(404).send('Client not found');
        }
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});


// --- Gemini Generation Routes ---

// 1. Topic Discovery
app.post('/api/generate/topic', async (req, res) => {
    const { clientId } = req.body;
    let client;
    try {
       const result = await pool.query('SELECT * FROM clients WHERE id = $1', [clientId]);
       if (result.rows.length === 0) {
           return res.status(404).json({ error: 'Client not found' });
       }
       client = result.rows[0];
    } catch(dbError) {
        console.error('DB Error fetching client:', dbError);
        return res.status(500).json({ error: 'Database error' });
    }

    try {
        // Use the new helper function for topic deduplication
        const topicResult = await generateUniqueTopicForClient(clientId, client);
        
        res.json({ 
            topic: topicResult.topic, 
            sources: topicResult.sources,
            existingTopicsAvoided: topicResult.existingTopicsCount
        });

    } catch (error) {
        console.error('Error generating topic:', error);
        res.status(500).json({ error: 'Failed to generate topic from Gemini API' });
    }
});

// 2. Content Planning
app.post('/api/generate/plan', async (req, res) => {
    const { clientId, topic } = req.body;
    
    if(!topic) {
        return res.status(400).json({ error: 'Topic is required' });
    }
    
    let client;
    try {
       const result = await pool.query('SELECT * FROM clients WHERE id = $1', [clientId]);
       if (result.rows.length === 0) {
           return res.status(404).json({ error: 'Client not found' });
       }
       client = result.rows[0];
    } catch(dbError) {
        console.error('DB Error fetching client:', dbError);
        return res.status(500).json({ error: 'Database error' });
    }

    try {
        const prompt = `
            You are an expert content strategist for a company in the '${client.industry}' industry.
            Company's unique value proposition: '${client.uniqueValueProp}'
            Company's brand voice: '${client.brandVoice}'
            Company's content strategy: '${client.contentStrategy}'
            We want to write a blog post about the following topic: '${topic}'

            Please generate a compelling, SEO-friendly blog post title, a unique angle for the article, and a list of 5-7 relevant SEO keywords.
        `;
        
        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: prompt,
            config: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        title: { type: Type.STRING, description: 'The SEO-friendly blog post title.' },
                        angle: { type: Type.STRING, description: 'The unique angle for the article.' },
                        keywords: {
                            type: Type.ARRAY,
                            items: { type: Type.STRING },
                            description: 'A list of 5-7 relevant SEO keywords.'
                        }
                    },
                    required: ["title", "angle", "keywords"]
                },
            },
        });
        
        const plan = JSON.parse(response.text);
        res.json(plan);

    } catch (error) {
        console.error('Error generating plan:', error);
        res.status(500).json({ error: 'Failed to generate plan from Gemini API' });
    }
});

// 3. Outline Generation
app.post('/api/generate/outline', async (req, res) => {
    const { clientId, topic, title, angle, keywords } = req.body;
    
    if(!topic || !title || !angle || !keywords) {
        return res.status(400).json({ error: 'Topic, title, angle, and keywords are required' });
    }
    
    let client;
    try {
       const result = await pool.query('SELECT * FROM clients WHERE id = $1', [clientId]);
       if (result.rows.length === 0) {
           return res.status(404).json({ error: 'Client not found' });
       }
       client = result.rows[0];
    } catch(dbError) {
        console.error('DB Error fetching client:', dbError);
        return res.status(500).json({ error: 'Database error' });
    }

    try {
        const prompt = `
            You are an expert content writer for a company in the '${client.industry}' industry.
            Company's unique value proposition: '${client.uniqueValueProp}'
            Company's brand voice: '${client.brandVoice}'
            Company's content strategy: '${client.contentStrategy}'
            
            Create a detailed blog post outline for:
            Topic: ${topic}
            Title: ${title}
            Angle: ${angle}
            Target Keywords: ${keywords.join(', ')}
            
            Create a comprehensive outline with main headings, subheadings, and key points to cover.
            Include an introduction, main sections, and conclusion.
            Ensure the outline is SEO-optimized and follows best practices for blog content.
        `;
        
        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: prompt,
            config: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        outline: { type: Type.STRING, description: 'Detailed blog post outline with headings and key points.' },
                        estimatedWordCount: { type: Type.NUMBER, description: 'Estimated word count for the full article.' },
                        seoScore: { type: Type.NUMBER, description: 'SEO optimization score out of 100.' }
                    },
                    required: ["outline", "estimatedWordCount", "seoScore"]
                },
            },
        });
        
        const outlineData = JSON.parse(response.text);
        res.json(outlineData);

    } catch (error) {
        console.error('Error generating outline:', error);
        res.status(500).json({ error: 'Failed to generate outline from Gemini API' });
    }
});

// Generate Supporting Titles based on a main title
app.post('/api/generate/supporting-titles', async (req, res) => {
    const { clientId, mainTitle, count = 3 } = req.body;
    if (!clientId || !mainTitle) {
        return res.status(400).json({ error: 'clientId and mainTitle are required' });
    }

    let client;
    try {
        const result = await pool.query('SELECT * FROM clients WHERE id = $1', [clientId]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Client not found' });
        }
        client = result.rows[0];
    } catch (dbError) {
        console.error('DB Error fetching client:', dbError);
        return res.status(500).json({ error: 'Database error' });
    }

    try {
        const prompt = `
            You are an expert content strategist for a company in the '${client.industry}' industry.
            Company's unique value proposition: '${client.uniqueValueProp}'
            Company's brand voice: '${client.brandVoice}'
            Company's content strategy: '${client.contentStrategy}'

            The main article title is: "${mainTitle}".

            Generate ${count} highly relevant supporting article titles that:
            - Are distinct topics that complement the main article
            - Avoid duplicating the main article topic
            - Are suitable as internal-link supporting posts
            - Are SEO-friendly and specific

            Return JSON with an array 'titles' of strings.
        `;

        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: prompt,
            config: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        titles: { type: Type.ARRAY, items: { type: Type.STRING } }
                    },
                    required: ["titles"]
                },
            },
        });

        const data = JSON.parse(response.text);
        const titles = Array.isArray(data.titles) ? data.titles.slice(0, count) : [];
        return res.json({ titles });
    } catch (error) {
        console.error('Error generating supporting titles:', error);
        return res.status(500).json({ error: 'Failed to generate supporting titles' });
    }
});

// 4. Content Generation
app.post('/api/generate/content', async (req, res) => {
    const { clientId, topic, title, angle, keywords, outline } = req.body;
    
    if(!topic || !title || !outline) {
        return res.status(400).json({ error: 'Topic, title, and outline are required' });
    }
    
    let client;
    try {
       const result = await pool.query('SELECT * FROM clients WHERE id = $1', [clientId]);
       if (result.rows.length === 0) {
           return res.status(404).json({ error: 'Client not found' });
       }
       client = result.rows[0];
    } catch(dbError) {
        console.error('DB Error fetching client:', dbError);
        return res.status(500).json({ error: 'Database error' });
    }

    // Get available internal links from sitemap
    let internalLinks = [];
    try {
        const linkResult = await pool.query(
            'SELECT url, title, description, category, keywords FROM sitemap_urls WHERE client_id = $1 AND title IS NOT NULL ORDER BY "createdAt" DESC LIMIT 20',
            [clientId]
        );
        internalLinks = linkResult.rows;
        console.log(`Found ${internalLinks.length} internal links for client ${clientId}`);
        
        // If no analyzed links, try to get any sitemap URLs
        if (internalLinks.length === 0) {
            const allLinksResult = await pool.query(
                'SELECT url FROM sitemap_urls WHERE client_id = $1 ORDER BY "createdAt" DESC LIMIT 10',
                [clientId]
            );
            console.log(`Found ${allLinksResult.rows.length} total sitemap URLs for client ${clientId}`);
            
            // Use basic URLs if no analyzed ones available
            if (allLinksResult.rows.length > 0) {
                internalLinks = allLinksResult.rows.map(row => ({
                    url: row.url,
                    title: `Page: ${row.url.split('/').pop() || 'Home'}`,
                    description: 'Internal page',
                    category: 'general',
                    keywords: 'related content'
                }));
                console.log(`Using ${internalLinks.length} basic internal links`);
            }
        }
    } catch (linkError) {
        console.log('Failed to fetch internal links:', linkError.message);
    }

    try {
        const internalLinksContext = internalLinks.length > 0 
            ? `\nAvailable Internal Links (use these EXACT templates, maximum ONE use per template):
               ${internalLinks.map((link, index) => 
                 `${index + 1}. Template: {{LINK_${index + 1}}}
                    Page Title: "${link.title}"
                    What it's about: ${link.description || 'Blog/page content'}
                    Category: ${link.category || 'general'}
                    Keywords: ${link.keywords || 'N/A'}
               `).join('\n')}
               
               🚨 CRITICAL LINKING RULES: 
               - Use EXACT templates shown above: {{LINK_1}}, {{LINK_2}}, etc.
               - Format: <a href="{{LINK_1}}">descriptive anchor text</a>
               - Maximum ONE use per template - NO EXCEPTIONS
               - Only link when there is GENUINE topical relevance
               - Choose 2-4 most relevant templates for your content
               - Anchor text must describe what the linked page is about
               - NEVER create your own URLs - only use the templates provided`
            : '\nNo internal links available yet - do not create any internal links.';

        const contentStyleContext = createContentStyleContext(internalLinks);
        
        const prompt = `
            You are an expert content writer for a company in the '${client.industry}' industry.
            Company's unique value proposition: '${client.uniqueValueProp}'
            Company's brand voice: '${client.brandVoice}'
            Company's content strategy: '${client.contentStrategy}'
            ${contentStyleContext}
            
            Write a complete blog post based on:
            Topic: ${topic}
            Title: ${title}
            Angle: ${angle}
            Target Keywords: ${keywords.join(', ')}
            Outline: ${outline}
            ${internalLinksContext}
            
            Requirements:
            - Write in HTML format with proper headings (h1, h2, h3)
            - Include the target keywords naturally throughout
            - Write in the company's brand voice
            - Make it engaging and valuable for readers
            - Include a compelling introduction and strong conclusion
            - Aim for 1500-2500 words
            
            CRITICAL PARAGRAPH FORMATTING RULES:
            - Follow the 2-4 sentence rule: Each paragraph should be 2-4 sentences maximum
            - One idea per paragraph: Each paragraph focuses on a single, distinct point
            - Use single-sentence paragraphs for emphasis, transitions, or questions
            - Think mobile-first: Paragraphs that look good on desktop must work on smartphones
            - Create white space: Short paragraphs improve readability and reduce eye strain
            - Break up dense content: If a paragraph looks too long, split it up
            - Use bulleted lists when appropriate instead of long paragraphs
            
            PARAGRAPH EXAMPLES:
            ✅ GOOD (2-4 sentences, one idea):
            "Good SEO helps potential customers find you through search engines. It involves optimizing your site's structure, content, and authority. By ranking higher for relevant keywords, you attract qualified traffic. This leads to more leads and sales for your business."
            
            ❌ BAD (wall of text):
            "Good SEO is the practice of helping potential customers find you through search engines because it involves optimizing your site's structure, content, and overall authority so that you can rank higher for the keywords that people are searching for..."
            
            ✅ SINGLE-SENTENCE PARAGRAPH for emphasis:
            "This is the key point that changes everything."
            
            Remember: Mobile users will see longer paragraphs as intimidating blocks of text.
            - INTERNAL LINKING RULES:
              * CRITICAL: Use ONLY the template placeholders provided: {{LINK_1}}, {{LINK_2}}, etc.
              * MAXIMUM ONE use per template - NEVER use the same template twice
              * Only link when there is a GENUINE contextual connection to the topic
              * Be VERY SELECTIVE - only 2-4 truly relevant templates, not forced linking
              * Use anchor text that EXACTLY matches what the linked page is about
              * Links must feel NATURAL and provide real value to readers
              * Format links as: <a href="{{LINK_1}}">precise descriptive anchor text</a>
              * EXAMPLE: <a href="{{LINK_2}}">auto insurance coverage</a>
              * NEVER create your own URLs or modify templates
              * If no templates are genuinely relevant to your topic, use fewer links or none
              * Quality over quantity - better to have 2 perfect links than 6 poor ones
        `;
        
        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: prompt,
            config: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        content: { type: Type.STRING, description: 'Complete blog post content in HTML format.' },
                        wordCount: { type: Type.NUMBER, description: 'Actual word count of the content.' },
                        metaDescription: { type: Type.STRING, description: 'SEO meta description (150-160 characters).' },
                        faqs: {
                            type: Type.ARRAY,
                            items: {
                                type: Type.OBJECT,
                                properties: {
                                    question: { type: Type.STRING },
                                    answer: { type: Type.STRING }
                                }
                            },
                            description: 'FAQ section with 3-5 relevant questions and answers.'
                        }
                    },
                    required: ["content", "wordCount", "metaDescription", "faqs"]
                },
            },
        });
        
        const contentData = JSON.parse(response.text);
        
        // Apply template-based URL replacement
        console.log('🔧 Applying template-based URL replacement...');
        contentData.content = replaceUrlTemplatesWithReal(contentData.content, internalLinks);
        
        // Validate internal links in generated content
        validateInternalLinks(contentData.content, internalLinks);
        
        // Validate external links in generated content
        await validateExternalLinks(contentData.content);
        
        res.json(contentData);

    } catch (error) {
        console.error('Error generating content:', error);
        res.status(500).json({ error: 'Failed to generate content from Gemini API' });
    }
});

// 5. Image Generation
app.post('/api/generate/images', async (req, res) => {
    const { clientId, title, headings } = req.body;
    
    if(!title) {
        return res.status(400).json({ error: 'Title is required' });
    }
    
    let client;
    try {
       const result = await pool.query('SELECT * FROM clients WHERE id = $1', [clientId]);
       if (result.rows.length === 0) {
           return res.status(404).json({ error: 'Client not found' });
       }
       client = result.rows[0];
    } catch(dbError) {
        console.error('DB Error fetching client:', dbError);
        return res.status(500).json({ error: 'Database error' });
    }

    try {
        // Generate featured image using our new image generation function
        const imageData = await generateFeaturedImage(title, client.industry);

        // Generate in-body images for key headings
        const inBodyImages = [];
        if (headings && headings.length > 0) {
            for (const heading of headings.slice(0, 3)) { // Limit to first 3 headings
                const imageResponse = await ai.models.generateContent({
                    model: "gemini-2.5-flash",
                    contents: `Create a relevant illustration or diagram for the section "${heading}" in a blog post about "${title}" in the ${client.industry} industry.`,
                    config: {
                        tools: [{
                            codeExecution: {}
                        }]
                    }
                });
                
                inBodyImages.push({
                    heading: heading,
                    description: `Illustration for ${heading}`,
                    placeholder: `[Image: ${heading}]`
                });
            }
        }

        res.json({
            featuredImage: {
                imageBase64: imageData.imageBase64,
                altText: imageData.altText,
                description: imageData.description,
                specifications: imageData.specifications
            },
            inBodyImages: inBodyImages
        });

    } catch (error) {
        console.error('Error generating images:', error);
        res.status(500).json({ error: 'Failed to generate images from Gemini API' });
    }
});

// 6. WordPress Publishing
app.post('/api/publish/wordpress', async (req, res) => {
    const { clientId, title, content, metaDescription, featuredImage, tags, categories, publishNow, scheduleAt, slug } = req.body;
    
    if(!clientId || !title || !content) {
        return res.status(400).json({ error: 'Client ID, title, and content are required' });
    }
    
    let client;
    try {
       const result = await pool.query('SELECT * FROM clients WHERE id = $1', [clientId]);
       if (result.rows.length === 0) {
           return res.status(404).json({ error: 'Client not found' });
       }
       client = result.rows[0];
    } catch(dbError) {
        console.error('DB Error fetching client:', dbError);
        return res.status(500).json({ error: 'Database error' });
    }

    // Check if WordPress credentials are configured
    if (!client.wp || !client.wp.url || !client.wp.username || !client.wp.appPassword) {
        console.log('WordPress credentials check failed:', {
            hasWp: !!client.wp,
            hasUrl: !!client.wp?.url,
            hasUsername: !!client.wp?.username,
            hasAppPassword: !!client.wp?.appPassword
        });
        return res.status(400).json({ 
            error: 'WordPress credentials not configured for this client',
            details: 'Please ensure WordPress URL, username, and app password are set in client settings'
        });
    }

    try {
        // Prepare WordPress API URL
        const wpApiUrl = `${client.wp.url.replace(/\/$/, '')}/wp-json/wp/v2/posts`;
        console.log('WordPress API URL:', wpApiUrl);
        
        // Handle tags - convert tag names to IDs or create new tags
        let tagIds = [];
        if (tags && tags.length > 0) {
            for (const tagName of tags) {
                try {
                    // First, try to find existing tag
                    const tagSearchUrl = `${client.wp.url.replace(/\/$/, '')}/wp-json/wp/v2/tags?search=${encodeURIComponent(tagName)}`;
                    const tagSearchResponse = await fetch(tagSearchUrl, {
                        headers: {
                            'Authorization': `Basic ${Buffer.from(`${client.wp.username}:${client.wp.appPassword}`).toString('base64')}`
                        }
                    });
                    
                    if (tagSearchResponse.ok) {
                        const existingTags = await tagSearchResponse.json();
                        const existingTag = existingTags.find(tag => tag.name.toLowerCase() === tagName.toLowerCase());
                        
                        if (existingTag) {
                            tagIds.push(existingTag.id);
                        } else {
                            // Create new tag
                            const tagCreateUrl = `${client.wp.url.replace(/\/$/, '')}/wp-json/wp/v2/tags`;
                            const tagCreateResponse = await fetch(tagCreateUrl, {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                    'Authorization': `Basic ${Buffer.from(`${client.wp.username}:${client.wp.appPassword}`).toString('base64')}`
                                },
                                body: JSON.stringify({ name: tagName })
                            });
                            
                            if (tagCreateResponse.ok) {
                                const newTag = await tagCreateResponse.json();
                                tagIds.push(newTag.id);
                            }
                        }
                    }
                } catch (tagError) {
                    console.log(`Failed to process tag "${tagName}":`, tagError.message);
                }
            }
        }

        // Add Open Graph meta tags if featured image is available
        let enhancedContent = content;
        if (featuredImageId) {
            try {
                const mediaResponse = await fetch(`${client.wp.url.replace(/\/$/, '')}/wp-json/wp/v2/media/${featuredImageId}`, {
                    headers: {
                        'Authorization': `Basic ${Buffer.from(`${client.wp.username}:${client.wp.appPassword}`).toString('base64')}`
                    }
                });
                
                if (mediaResponse.ok) {
                    const mediaData = await mediaResponse.json();
                    const imageUrl = mediaData.source_url;
                    
                    const openGraphTags = generateOpenGraphTags(
                        title,
                        metaDescription || `Professional ${client.industry} insights from ${client.name}`,
                        imageUrl,
                        `${client.wp.url}`,
                        client.name
                    );
                    
                    enhancedContent = openGraphTags + content;
                    console.log(`🌐 Added Open Graph meta tags with featured image: ${imageUrl}`);
                }
            } catch (ogError) {
                console.warn('⚠️ Failed to add Open Graph tags:', ogError.message);
            }
        }

        // Prepare post data
        const postData = {
            title: title,
            content: enhancedContent,
            excerpt: metaDescription || '',
            status: 'draft', // default to draft unless publish or schedule specified
            tags: tagIds // Use tag IDs
        };

        // Apply slug if provided
        if (slug && typeof slug === 'string' && slug.trim().length > 0) {
            postData.slug = slug.trim();
        }

        // Apply publish/schedule logic
        if (publishNow === true) {
            postData.status = 'publish';
        } else if (scheduleAt && typeof scheduleAt === 'string') {
            try {
                const scheduleDate = new Date(scheduleAt);
                if (!isNaN(scheduleDate.getTime())) {
                    postData.status = 'future';
                    // Use UTC to avoid timezone drift
                    postData.date_gmt = scheduleDate.toISOString();
                }
            } catch (_) {
                // ignore invalid scheduleAt; keep as draft
            }
        }
        console.log('WordPress post data prepared:', { title, contentLength: content.length, status: postData.status, tagIds });

        // Create WordPress post using REST API
        // Enhanced WordPress API call with WordFence compatibility
        console.log('📝 Creating WordPress post...');
        console.log('🔗 WordPress API URL:', wpApiUrl);
        console.log('📊 Post data:', { 
            title: postData.title, 
            contentLength: postData.content.length, 
            status: postData.status,
            hasFeaturedMedia: !!postData.featured_media 
        });
        
        const wpResponse = await fetch(wpApiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Basic ${Buffer.from(`${client.wp.username}:${client.wp.appPassword}`).toString('base64')}`
            },
            body: JSON.stringify(postData)
        });
        
        console.log('📊 WordPress API response status:', wpResponse.status);
        console.log('📋 WordPress API response headers:', Object.fromEntries(wpResponse.headers.entries()));

        console.log('WordPress API response status:', wpResponse.status);

        if (!wpResponse.ok) {
            const errorText = await wpResponse.text();
            console.error('WordPress API Error Details:', {
                status: wpResponse.status,
                statusText: wpResponse.statusText,
                errorText: errorText,
                url: wpApiUrl,
                username: client.wp.username
            });
            throw new Error(`WordPress publishing failed: ${wpResponse.status} ${wpResponse.statusText} - ${errorText}`);
        }

        const wpPost = await wpResponse.json();

        // Store the published topic to avoid duplicates
        try {
            await pool.query(
                'INSERT INTO used_topics (client_id, topic) VALUES ($1, $2)',
                [clientId, title]
            );
        } catch (topicError) {
            console.log('Topic already exists or error storing:', topicError.message);
        }

        // Auto-update: Add published blog to sitemap database for future internal linking
        await addBlogToSitemapDatabase(clientId, wpPost.link, title, metaDescription || 'Generated blog post');

        res.json({
            success: true,
            postId: wpPost.id,
            postUrl: wpPost.link,
            editUrl: wpPost.link ? wpPost.link.replace(/\/$/, '') + '/wp-admin/post.php?post=' + wpPost.id + '&action=edit' : null,
            status: wpPost.status,
            message: 'Blog post successfully created as draft in WordPress for review'
        });

    } catch (error) {
        console.error('Error publishing to WordPress:', error);
        res.status(500).json({ 
            error: 'Failed to publish to WordPress', 
            details: error.message 
        });
    }
});

// Sitemap Management Endpoints
app.post('/api/sitemap/parse', async (req, res) => {
    const { clientId } = req.body;
    
    if(!clientId) {
        return res.status(400).json({ error: 'Client ID is required' });
    }
    
    let client;
    try {
       const result = await pool.query('SELECT * FROM clients WHERE id = $1', [clientId]);
       if (result.rows.length === 0) {
           return res.status(404).json({ error: 'Client not found' });
       }
       client = result.rows[0];
    } catch(dbError) {
        console.error('DB Error fetching client:', dbError);
        return res.status(500).json({ error: 'Database error' });
    }

    if (!client.sitemapUrl) {
        return res.status(400).json({ error: 'No sitemap URL configured for this client' });
    }

    try {
        const urlCount = await parseSitemapForClient(clientId, client.sitemapUrl);
        res.json({
            success: true,
            message: `Successfully parsed ${urlCount} URLs from sitemap`,
            urlCount: urlCount,
            sitemapUrl: client.sitemapUrl
        });
    } catch (error) {
        console.error('Error parsing sitemap:', error);
        res.status(500).json({ 
            error: 'Failed to parse sitemap', 
            details: error.message 
        });
    }
});

app.get('/api/sitemap/urls/:clientId', async (req, res) => {
    const { clientId } = req.params;
    
    try {
        const result = await pool.query(
            'SELECT url, title, description, category, keywords, last_modified FROM sitemap_urls WHERE client_id = $1 ORDER BY "createdAt" DESC',
            [clientId]
        );
        
        res.json({
            success: true,
            urls: result.rows,
            count: result.rows.length
        });
    } catch (error) {
        console.error('Error fetching sitemap URLs:', error);
        res.status(500).json({ 
            error: 'Failed to fetch sitemap URLs', 
            details: error.message 
        });
    }
});

// Debug: Check internal links for a client
app.get('/api/debug/internal-links/:clientId', async (req, res) => {
    const { clientId } = req.params;
    
    try {
        // Get client info
        const clientResult = await pool.query('SELECT name, "sitemapUrl" FROM clients WHERE id = $1', [clientId]);
        const client = clientResult.rows[0];
        
        if (!client) {
            return res.status(404).json({ error: 'Client not found' });
        }
        
        // Get all sitemap URLs
        const allUrlsResult = await pool.query(
            'SELECT url, title, description, category, keywords, "createdAt" FROM sitemap_urls WHERE client_id = $1 ORDER BY "createdAt" DESC',
            [clientId]
        );
        
        // Get analyzed URLs (with titles)
        const analyzedUrlsResult = await pool.query(
            'SELECT url, title, description, category, keywords FROM sitemap_urls WHERE client_id = $1 AND title IS NOT NULL ORDER BY "createdAt" DESC',
            [clientId]
        );
        
        res.json({
            client: {
                name: client.name,
                sitemapUrl: client.sitemapUrl
            },
            stats: {
                totalUrls: allUrlsResult.rows.length,
                analyzedUrls: analyzedUrlsResult.rows.length,
                hasSitemap: !!client.sitemapUrl
            },
            allUrls: allUrlsResult.rows,
            analyzedUrls: analyzedUrlsResult.rows
        });
    } catch (error) {
        console.error('Error debugging internal links:', error);
        res.status(500).json({ 
            error: 'Failed to fetch debug info', 
            details: error.message 
        });
    }
});

// Clean up existing database URLs that may have absolute URLs
app.post('/api/admin/cleanup-urls', async (req, res) => {
    try {
        console.log('🧹 Starting database URL cleanup...');
        
        // Get all URLs that need cleaning (contain http or are WordPress posts)
        const result = await pool.query(`
            SELECT client_id, url, title, description, category, keywords 
            FROM sitemap_urls 
            WHERE url LIKE 'http%' OR url LIKE '%?p=%'
        `);
        
        console.log(`Found ${result.rows.length} URLs that need cleaning`);
        
        let cleaned = 0;
        let removed = 0;
        
        for (const row of result.rows) {
            let cleanUrl = row.url;
            
            // Extract path from absolute URL
            if (cleanUrl.includes('://')) {
                try {
                    const urlObj = new URL(cleanUrl);
                    cleanUrl = urlObj.pathname;
                } catch (e) {
                    console.log(`❌ Removing invalid URL: ${cleanUrl}`);
                    await pool.query('DELETE FROM sitemap_urls WHERE client_id = $1 AND url = $2', [row.client_id, row.url]);
                    removed++;
                    continue;
                }
            }
            
            // Convert WordPress posts to homepage
            if (cleanUrl.includes('?p=') || cleanUrl === '/' || cleanUrl === '') {
                cleanUrl = '/';
            }
            
            // Update the URL
            if (cleanUrl !== row.url) {
                await pool.query(
                    'UPDATE sitemap_urls SET url = $1 WHERE client_id = $2 AND url = $3',
                    [cleanUrl, row.client_id, row.url]
                );
                console.log(`🔧 Cleaned: ${row.url} → ${cleanUrl}`);
                cleaned++;
            }
        }
        
        res.json({
            success: true,
            message: `Database cleanup complete: ${cleaned} URLs cleaned, ${removed} invalid URLs removed`,
            cleaned: cleaned,
            removed: removed
        });
        
    } catch (error) {
        console.error('Error cleaning up URLs:', error);
        res.status(500).json({ error: 'Failed to cleanup URLs', details: error.message });
    }
});

// NEW: XML Sitemap Parsing Test with validation
app.post('/api/test/sitemap', async (req, res) => {
    const { clientId, sitemapUrl } = req.body;
    
    if(!clientId) {
        return res.status(400).json({ error: 'Client ID is required' });
    }
    
    if(!sitemapUrl) {
        return res.status(400).json({ error: 'Sitemap URL is required' });
    }
    
    try {
        // CRITICAL: Validate client ownership first
        const clientInfo = await validateClientOwnership(clientId, 'Sitemap Test');
        
        console.log(`🗺️ Testing XML sitemap parsing for client ${clientInfo.name}: ${sitemapUrl}`);
        
        // CRITICAL: Validate sitemap domain matches client domain
        const domainValid = await validateUrlDomain(clientId, sitemapUrl, clientInfo);
        if (!domainValid) {
            return res.status(400).json({ 
                error: 'Domain mismatch: Sitemap URL domain does not match client website domain',
                details: `Client "${clientInfo.name}" cannot use sitemap from a different domain`,
                suggestion: 'Please provide a sitemap URL from the same domain as the client website'
            });
        }
        
        // Test the new XML sitemap parsing function
        const parseResult = await parseXMLSitemapForClient(clientId, sitemapUrl);
        
        // Get current URLs in database for this client
        const existingUrls = await pool.query(
            'SELECT url, title, description, category, last_modified FROM sitemap_urls WHERE client_id = $1 ORDER BY last_modified DESC',
            [clientId]
        );
        
        res.json({
            success: true,
            client: {
                id: clientId,
                name: clientInfo.name,
                sitemapUrl: sitemapUrl
            },
            parsing: {
                method: 'XML Sitemap Parser',
                totalFound: parseResult.totalFound,
                stored: parseResult.stored,
                skipped: parseResult.skipped,
                performance: 'Much faster than AI crawling!',
                samplePages: parseResult.urls.slice(0, 8).map(page => ({
                    url: page.url,
                    title: page.title,
                    lastModified: page.lastModified,
                    priority: page.priority
                }))
            },
            database: {
                totalUrls: existingUrls.rows.length,
                recentUrls: existingUrls.rows.slice(0, 5).map(row => ({
                    url: row.url,
                    title: row.title,
                    description: row.description,
                    category: row.category,
                    lastModified: row.last_modified
                }))
            },
            message: `🚀 XML sitemap parsing SUCCESS! Found ${parseResult.totalFound} URLs, stored ${parseResult.stored}. Database now has ${existingUrls.rows.length} total URLs for this client.`,
            advantages: [
                '🏆 Complete URL coverage (vs ~30 from AI crawling)',
                '⚡ 10x faster performance',
                '💰 No Gemini API costs for URL discovery',
                '🎯 Authoritative source (client\'s own sitemap)',
                '🔄 Easy to keep current with new content'
            ]
        });
        
    } catch (error) {
        console.error('Error testing XML sitemap parsing:', error);
        res.status(500).json({ 
            error: 'Failed to test XML sitemap parsing', 
            details: error.message,
            suggestion: 'Check if the sitemap URL is accessible and contains valid XML'
        });
    }
});

// CRITICAL: Database cleanup endpoint to remove cross-contaminated URLs
app.post('/api/admin/cleanup-cross-contamination', async (req, res) => {
    try {
        console.log('🧹 Starting cross-contamination cleanup...');
        
        // Get all clients with their domains
        const clients = await pool.query('SELECT id, name, "websiteUrl" FROM clients WHERE "websiteUrl" IS NOT NULL');
        
        let totalCleaned = 0;
        let cleanupResults = [];
        
        for (const client of clients.rows) {
            try {
                const clientDomain = new URL(client.websiteUrl).hostname.toLowerCase();
                
                // Find URLs that don't match this client's domain
                const crossUrls = await pool.query(`
                    SELECT id, url, title 
                    FROM sitemap_urls 
                    WHERE client_id = $1 
                    AND url LIKE 'http%' 
                    AND url NOT LIKE $2
                `, [client.id, `%${clientDomain}%`]);
                
                if (crossUrls.rows.length > 0) {
                    // Delete cross-contaminated URLs
                    const deleteResult = await pool.query(`
                        DELETE FROM sitemap_urls 
                        WHERE client_id = $1 
                        AND url LIKE 'http%' 
                        AND url NOT LIKE $2
                    `, [client.id, `%${clientDomain}%`]);
                    
                    const cleanedCount = deleteResult.rowCount;
                    totalCleaned += cleanedCount;
                    
                    cleanupResults.push({
                        client: client.name,
                        domain: clientDomain,
                        cleaned: cleanedCount,
                        examples: crossUrls.rows.slice(0, 3).map(row => row.url)
                    });
                    
                    console.log(`🧹 Cleaned ${cleanedCount} cross-contaminated URLs for ${client.name}`);
                }
                
            } catch (clientError) {
                console.error(`Error processing client ${client.name}:`, clientError.message);
                cleanupResults.push({
                    client: client.name,
                    error: clientError.message
                });
            }
        }
        
        res.json({
            success: true,
            message: `Cross-contamination cleanup complete: ${totalCleaned} URLs removed`,
            totalCleaned: totalCleaned,
            results: cleanupResults
        });
        
    } catch (error) {
        console.error('Error during cross-contamination cleanup:', error);
        res.status(500).json({ 
            error: 'Failed to cleanup cross-contamination', 
            details: error.message 
        });
    }
});

// LEGACY: Website Crawling Test (keeping for comparison)
app.post('/api/test/crawl', async (req, res) => {
    const { clientId, websiteUrl } = req.body;
    
    if(!clientId) {
        return res.status(400).json({ error: 'Client ID is required' });
    }
    
    if(!websiteUrl) {
        return res.status(400).json({ error: 'Website URL is required' });
    }
    
    try {
        // Get client info
        const result = await pool.query('SELECT name FROM clients WHERE id = $1', [clientId]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Client not found' });
        }
        
        const client = result.rows[0];
        
        console.log(`Testing website crawl for client ${client.name}: ${websiteUrl}`);
        
        // Test the crawling function
        const crawledCount = await crawlWebsiteForClient(clientId, websiteUrl);
        
        // Get current URLs in database for this client
        const existingUrls = await pool.query(
            'SELECT url, title, description, category FROM sitemap_urls WHERE client_id = $1 ORDER BY last_modified DESC',
            [clientId]
        );
        
        res.json({
            success: true,
            client: {
                id: clientId,
                name: client.name,
                websiteUrl: websiteUrl
            },
            crawl: {
                totalPagesFound: crawledCount,
                samplePages: existingUrls.rows.slice(0, 5).map(row => ({
                    url: row.url,
                    title: row.title,
                    description: row.description,
                    category: row.category
                }))
            },
            database: {
                existingUrls: existingUrls.rows.length,
                sampleExisting: existingUrls.rows.slice(0, 3)
            },
            message: `Successfully crawled website and found ${crawledCount} pages. Database has ${existingUrls.rows.length} total URLs for this client.`
        });
        
    } catch (error) {
        console.error('Error testing website crawl:', error);
        res.status(500).json({ 
            error: 'Failed to test website crawling', 
            details: error.message 
        });
    }
});

// WordPress Connection Test
app.post('/api/test/wordpress', async (req, res) => {
    const { clientId } = req.body;
    
    if(!clientId) {
        return res.status(400).json({ error: 'Client ID is required' });
    }
    
    let client;
    try {
       const result = await pool.query('SELECT * FROM clients WHERE id = $1', [clientId]);
       if (result.rows.length === 0) {
           return res.status(404).json({ error: 'Client not found' });
       }
       client = result.rows[0];
    } catch(dbError) {
        console.error('DB Error fetching client:', dbError);
        return res.status(500).json({ error: 'Database error' });
    }

    // Check if WordPress credentials are configured
    if (!client.wp || !client.wp.url || !client.wp.username || !client.wp.appPassword) {
        return res.status(400).json({ 
            error: 'WordPress credentials not configured',
            credentials: {
                hasUrl: !!client.wp?.url,
                hasUsername: !!client.wp?.username,
                hasAppPassword: !!client.wp?.appPassword
            }
        });
    }

    try {
        // Test WordPress REST API connection
        const wpApiUrl = `${client.wp.url.replace(/\/$/, '')}/wp-json/wp/v2/users/me`;
        console.log('Testing WordPress connection to:', wpApiUrl);
        
        const wpResponse = await fetch(wpApiUrl, {
            method: 'GET',
            headers: {
                'Authorization': `Basic ${Buffer.from(`${client.wp.username}:${client.wp.appPassword}`).toString('base64')}`
            }
        });

        if (!wpResponse.ok) {
            const errorText = await wpResponse.text();
            console.error('WordPress connection test failed:', errorText);
            return res.status(400).json({ 
                error: 'WordPress connection failed',
                status: wpResponse.status,
                details: errorText,
                suggestions: [
                    'Check if WordPress URL is correct and accessible',
                    'Verify username and app password are correct',
                    'Ensure WordPress REST API is enabled',
                    'Check if site has security plugins blocking API access'
                ]
            });
        }

        const userData = await wpResponse.json();
        
        res.json({
            success: true,
            message: 'WordPress connection successful',
            user: {
                id: userData.id,
                name: userData.name,
                username: userData.username,
                capabilities: userData.capabilities
            },
            siteUrl: client.wp.url
        });

    } catch (error) {
        console.error('Error testing WordPress connection:', error);
        res.status(500).json({ 
            error: 'Failed to test WordPress connection', 
            details: error.message 
        });
    }
});

// 7. Complete Blog Generation (All-in-One)
app.post('/api/generate/complete-blog', async (req, res) => {
    const { clientId } = req.body;
    
    if(!clientId) {
        return res.status(400).json({ error: 'Client ID is required' });
    }
    
    let client;
    try {
       const result = await pool.query('SELECT * FROM clients WHERE id = $1', [clientId]);
       if (result.rows.length === 0) {
           return res.status(404).json({ error: 'Client not found' });
       }
       client = result.rows[0];
    } catch(dbError) {
        console.error('DB Error fetching client:', dbError);
        return res.status(500).json({ error: 'Database error' });
    }

    try {
        // Step 1: Generate Topic (with deduplication)
        const topicResult = await generateUniqueTopicForClient(clientId, client);
        const topic = topicResult.topic;
        const sources = topicResult.sources;

        // Step 2: Generate Plan
        const planPrompt = `
            You are an expert content strategist for a company in the '${client.industry}' industry.
            Company's unique value proposition: '${client.uniqueValueProp}'
            Company's brand voice: '${client.brandVoice}'
            Company's content strategy: '${client.contentStrategy}'
            We want to write a blog post about the following topic: '${topic}'

            Please generate a compelling, SEO-friendly blog post title, a unique angle for the article, and a list of 5-7 relevant SEO keywords.
        `;
        
        const planResponse = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: planPrompt,
            config: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        title: { type: Type.STRING, description: 'The SEO-friendly blog post title.' },
                        angle: { type: Type.STRING, description: 'The unique angle for the article.' },
                        keywords: {
                            type: Type.ARRAY,
                            items: { type: Type.STRING },
                            description: 'A list of 5-7 relevant SEO keywords.'
                        }
                    },
                    required: ["title", "angle", "keywords"]
                },
            },
        });
        
        const plan = JSON.parse(planResponse.text);

        // Get internal links for complete blog generation too
        let internalLinks = [];
        try {
            const linkResult = await pool.query(
                'SELECT url, title, description, category, keywords FROM sitemap_urls WHERE client_id = $1 ORDER BY "createdAt" DESC LIMIT 20',
                [clientId]
            );
            internalLinks = linkResult.rows;
            
            // If no analyzed links, use basic URLs
            if (internalLinks.length === 0) {
                const allLinksResult = await pool.query(
                    'SELECT url FROM sitemap_urls WHERE client_id = $1 ORDER BY "createdAt" DESC LIMIT 10',
                    [clientId]
                );
                if (allLinksResult.rows.length > 0) {
                    internalLinks = allLinksResult.rows.map(row => ({
                        url: row.url,
                        title: `Page: ${row.url.split('/').pop() || 'Home'}`,
                        description: 'Internal page',
                        category: 'general',
                        keywords: 'related content'
                    }));
                }
            }
        } catch (linkError) {
            console.log('Failed to fetch internal links for complete blog:', linkError.message);
        }

        const internalLinksContext = internalLinks.length > 0 
            ? `\nAvailable Internal Links (use these EXACT templates, maximum ONE use per template):
               ${internalLinks.map((link, index) => 
                 `${index + 1}. Template: {{LINK_${index + 1}}}
                    Page Title: "${link.title}"
                    What it's about: ${link.description || 'Blog/page content'}
                    Category: ${link.category || 'general'}
                    Keywords: ${link.keywords || 'N/A'}
               `).join('\n')}
               
               🚨 CRITICAL LINKING RULES: 
               - Use EXACT templates shown above: {{LINK_1}}, {{LINK_2}}, etc.
               - Format: <a href="{{LINK_1}}">descriptive anchor text</a>
               - Maximum ONE use per template - NO EXCEPTIONS
               - Only link when there is GENUINE topical relevance
               - Choose 2-4 most relevant templates for your content
               - Anchor text must describe what the linked page is about
               - NEVER create your own URLs - only use the templates provided`
            : '\nNo internal links available yet - do not create any internal links.';

        // Step 3: Generate Complete Blog Post
        const contentStyleContext = createContentStyleContext(internalLinks);
        
        const contentPrompt = `
            You are an expert content writer for a company in the '${client.industry}' industry.
            Company's unique value proposition: '${client.uniqueValueProp}'
            Company's brand voice: '${client.brandVoice}'
            Company's content strategy: '${client.contentStrategy}'
            ${contentStyleContext}
            
            Write a complete blog post based on:
            Topic: ${topic}
            Title: ${plan.title}
            Angle: ${plan.angle}
            Target Keywords: ${plan.keywords.join(', ')}
            ${internalLinksContext}
            
            Requirements:
            - Write in HTML format with proper headings (h1, h2, h3)
            - Include the target keywords naturally throughout
            - Write in the company's brand voice
            - Make it engaging and valuable for readers
            - Include a compelling introduction and strong conclusion
            - Aim for 1500-2500 words
            
            CRITICAL PARAGRAPH FORMATTING RULES:
            - Follow the 2-4 sentence rule: Each paragraph should be 2-4 sentences maximum
            - One idea per paragraph: Each paragraph focuses on a single, distinct point
            - Use single-sentence paragraphs for emphasis, transitions, or questions
            - Think mobile-first: Paragraphs that look good on desktop must work on smartphones
            - Create white space: Short paragraphs improve readability and reduce eye strain
            - Break up dense content: If a paragraph looks too long, split it up
            - Use bulleted lists when appropriate instead of long paragraphs
            
            PARAGRAPH EXAMPLES:
            ✅ GOOD (2-4 sentences, one idea):
            "Good SEO helps potential customers find you through search engines. It involves optimizing your site's structure, content, and authority. By ranking higher for relevant keywords, you attract qualified traffic. This leads to more leads and sales for your business."
            
            ❌ BAD (wall of text):
            "Good SEO is the practice of helping potential customers find you through search engines because it involves optimizing your site's structure, content, and overall authority so that you can rank higher for the keywords that people are searching for..."
            
            ✅ SINGLE-SENTENCE PARAGRAPH for emphasis:
            "This is the key point that changes everything."
            
            Remember: Mobile users will see longer paragraphs as intimidating blocks of text.
            - INTERNAL LINKING RULES:
              * CRITICAL: Use ONLY the template placeholders provided: {{LINK_1}}, {{LINK_2}}, etc.
              * MAXIMUM ONE use per template - NEVER use the same template twice
              * Only link when there is a GENUINE contextual connection to the topic
              * Be VERY SELECTIVE - only 2-4 truly relevant templates, not forced linking
              * Use anchor text that EXACTLY matches what the linked page is about
              * Links must feel NATURAL and provide real value to readers
              * Format links as: <a href="{{LINK_1}}">precise descriptive anchor text</a>
              * EXAMPLE: <a href="{{LINK_2}}">auto insurance coverage</a>
              * NEVER create your own URLs or modify templates
              * If no templates are genuinely relevant to your topic, use fewer links or none
              * Quality over quantity - better to have 2 perfect links than 6 poor ones

            - CRITICAL: Only reference actual websites that exist and provide genuine information
            - NEVER create fictional URLs or hypothetical websites
            - PRIORITIZE THESE REAL AUTHORITATIVE SOURCES BY INDUSTRY:
              * Government sites (.gov domains) - use REAL government websites only
              * Industry associations and professional organizations (HIGHEST PRIORITY) - use REAL organizations
              * Major news publications: reuters.com, bbc.com, wsj.com, bloomberg.com, cnbc.com
              * Established research institutions and universities (.edu domains) - use REAL universities
              * Recognized industry publications and trade websites - use REAL publications only
              * Wikipedia (en.wikipedia.org) ONLY as absolute last resort for basic definitions
            - Links must be contextually integrated into the content naturally
            - Use descriptive, keyword-rich anchor text that accurately reflects the linked content
            - Format: <a href="URL" target="_blank" rel="noopener noreferrer">descriptive anchor text</a>
            - NEVER create fictional URLs or hypothetical websites
            - Only link to sources that genuinely provide the information referenced in your anchor text
            - EXAMPLES OF GOOD EXTERNAL LINKS (prioritize industry sources):
              * "The <a href=\"https://www.naic.org\" target=\"_blank\" rel=\"noopener noreferrer\">National Association of Insurance Commissioners</a> reports that..."
              * "According to <a href=\"https://www.iii.org\" target=\"_blank\" rel=\"noopener noreferrer\">Insurance Information Institute data</a>, claims have increased..."
              * "Recent <a href=\"https://www.reuters.com\" target=\"_blank\" rel=\"noopener noreferrer\">Reuters analysis</a> shows industry trends..."
              * "The <a href=\"https://www.osha.gov\" target=\"_blank\" rel=\"noopener noreferrer\">Occupational Safety and Health Administration</a> recommends..."
            - AVOID: Multiple Wikipedia links, generic definitions, irrelevant sources
            - Distribute links throughout the article naturally within relevant sentences
            - AVOID Wikipedia unless no other source exists for basic definitions
            - PRIORITIZE THESE AUTHORITATIVE SOURCES FOR ${client.industry.toUpperCase()} INDUSTRY:
              ${getIndustryAuthoritativeSources(client.industry).map(source => `* ${source} (USE THESE FIRST)`).join('\n              ')}
            - USE THESE INDUSTRY SOURCES BEFORE considering general sources like Wikipedia
            - Each external link should reference specific information, studies, or expert opinions
            
            FAQ REQUIREMENTS:
            - Generate 2-8 relevant FAQs based on the blog content
            - Questions should address common concerns readers might have about the topic
            - Answers should be comprehensive but concise (2-4 sentences each)
            - Focus on practical, actionable information
            - Use industry-specific terminology appropriately
            - Questions should naturally arise from the blog content and provide additional value
        `;
        
        const contentResponse = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: contentPrompt,
            config: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        content: { type: Type.STRING, description: 'Complete blog post content in HTML format.' },
                        wordCount: { type: Type.NUMBER, description: 'Actual word count of the content.' },
                        metaDescription: { type: Type.STRING, description: 'SEO meta description (150-160 characters).' },
                        faqs: {
                            type: Type.ARRAY,
                            items: {
                                type: Type.OBJECT,
                                properties: {
                                    question: { type: Type.STRING },
                                    answer: { type: Type.STRING }
                                }
                            },
                            description: 'FAQ section with 3-5 relevant questions and answers.'
                        }
                    },
                    required: ["content", "wordCount", "metaDescription", "faqs"]
                },
            },
        });
        
        const contentData = JSON.parse(contentResponse.text);

        // CRITICAL: Replace URL templates with actual URLs
        console.log('🔧 Applying template-based URL replacement to complete blog content...');
        contentData.content = replaceUrlTemplatesWithReal(contentData.content, internalLinks);
        
        // Validate internal links in complete blog content
        validateInternalLinks(contentData.content, internalLinks);
        
        // Validate external links in complete blog content
        await validateExternalLinks(contentData.content);

        // Generate FAQ HTML with schema markup
        const faqHTML = generateFAQHTML(contentData.faqs);
        
        // Combine main content with FAQ section
        const fullContent = contentData.content + faqHTML;

        // Return complete blog post data with FAQs
        res.json({
            topic: topic,
            sources: sources,
            plan: plan,
            content: {
                ...contentData,
                content: fullContent,
                faqsGenerated: contentData.faqs ? contentData.faqs.length : 0
            },
            readyToPublish: true
        });

    } catch (error) {
        console.error('Error generating complete blog:', error);
        res.status(500).json({ error: 'Failed to generate complete blog post' });
    }
});

// 8. "I'm Feelin' Lucky" - Generate and Auto-Publish Blog
app.post('/api/generate/lucky-blog', async (req, res) => {
    const { clientId } = req.body;
    
    if(!clientId) {
        return res.status(400).json({ error: 'Client ID is required' });
    }
    
    let client;
    try {
       const result = await pool.query('SELECT * FROM clients WHERE id = $1', [clientId]);
       if (result.rows.length === 0) {
           return res.status(404).json({ error: 'Client not found' });
       }
       client = result.rows[0];
    } catch(dbError) {
        console.error('DB Error fetching client:', dbError);
        return res.status(500).json({ error: 'Database error' });
    }

    // Check if WordPress credentials are configured
    if (!client.wp || !client.wp.url || !client.wp.username || !client.wp.appPassword) {
        return res.status(400).json({ 
            error: 'WordPress credentials not configured for this client',
            details: 'Please configure WordPress URL, username, and app password in client settings to use Lucky mode'
        });
    }

    try {
        console.log(`🍀 LUCKY MODE: Generating and auto-publishing blog for ${client.name}`);
        
        // Step 1: Generate Topic (with deduplication)
        console.log(`📝 Step 1: Starting topic generation with deduplication...`);
        const topicResult = await generateUniqueTopicForClient(clientId, client);
        const topic = topicResult.topic;
        const sources = topicResult.sources;
        console.log(`✅ Generated unique topic avoiding ${topicResult.existingTopicsCount} existing topics`);

        // Step 2: Generate Plan
        const planPrompt = `
            You are an expert content strategist for a company in the '${client.industry}' industry.
            Company's unique value proposition: '${client.uniqueValueProp}'
            Company's brand voice: '${client.brandVoice}'
            Company's content strategy: '${client.contentStrategy}'
            We want to write a blog post about the following topic: '${topic}'

            Please generate a compelling, SEO-friendly blog post title, a unique angle for the article, and a list of 5-7 relevant SEO keywords.
        `;
        
        const planResponse = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: planPrompt,
            config: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        title: { type: Type.STRING, description: 'The SEO-friendly blog post title.' },
                        angle: { type: Type.STRING, description: 'The unique angle for the article.' },
                        keywords: {
                            type: Type.ARRAY,
                            items: { type: Type.STRING },
                            description: 'A list of 5-7 relevant SEO keywords.'
                        }
                    },
                    required: ["title", "angle", "keywords"]
                },
            },
        });
        
        const plan = JSON.parse(planResponse.text);
        console.log(`✅ Step 2 Complete: Plan generated - "${plan.title}"`);

        // Step 3: Start Image Generation in Parallel (Non-blocking)
        console.log(`🖼️ Step 3: Starting parallel image generation...`);
        const imagePromise = generateFeaturedImage(plan.title, client.industry)
            .catch(error => {
                console.warn('⚠️ Image generation failed, continuing without image:', error.message);
                return null; // Return null on failure so Lucky mode continues
            });

        // Step 4: Get internal links
        let internalLinks = [];
        try {
            const linkResult = await pool.query(
                'SELECT url, title, description, category, keywords FROM sitemap_urls WHERE client_id = $1 ORDER BY "createdAt" DESC LIMIT 20',
                [clientId]
            );
            internalLinks = linkResult.rows;
            
            if (internalLinks.length === 0) {
                const allLinksResult = await pool.query(
                    'SELECT url FROM sitemap_urls WHERE client_id = $1 ORDER BY "createdAt" DESC LIMIT 10',
                    [clientId]
                );
                if (allLinksResult.rows.length > 0) {
                    internalLinks = allLinksResult.rows.map(row => ({
                        url: row.url,
                        title: `Page: ${row.url.split('/').pop() || 'Home'}`,
                        description: 'Internal page',
                        category: 'general',
                        keywords: 'related content'
                    }));
                }
            }
        } catch (linkError) {
            console.log('Failed to fetch internal links for lucky blog:', linkError.message);
        }

        // Step 4.5: Get real-time topical external links from Google Search
        console.log(`🔍 Step 4.5: Retrieving topic-specific external links for "${plan.title}"`);
        let topicalExternalLinks = [];
        try {
            const topicalLinksResult = await pool.query(
                'SELECT url, authority_score, domain FROM topic_external_links WHERE client_id = $1 AND topic = $2 AND is_validated = TRUE ORDER BY authority_score DESC LIMIT 8',
                [clientId, plan.title]
            );
            
            topicalExternalLinks = topicalLinksResult.rows.map(row => row.url);
            console.log(`🎯 Found ${topicalExternalLinks.length} validated topical external links`);
            
            topicalLinksResult.rows.forEach((link, index) => {
                console.log(`🔗 Topical Link ${index + 1}: ${link.url} [Authority: ${link.authority_score}] [${link.domain}]`);
            });
            
            // If no topical links found, do a dedicated Google Search for external links
            if (topicalExternalLinks.length === 0) {
                console.log(`🔍 No stored topical links found, performing dedicated Google Search for external links...`);
                
                const externalLinkSearchPrompt = `Using Google Search, find 8-10 authoritative sources about "${plan.title}" in the ${client.industry} industry. Focus on:
                - Government websites (.gov domains)
                - Industry associations and professional organizations
                - Educational institutions (.edu domains)  
                - Credible news sources (no paywalls)
                - Industry publications and trade websites
                
                Avoid paywalled sites like WSJ, Reuters premium, Bloomberg, etc.`;
                
                const externalSearchResponse = await ai.models.generateContent({
                    model: "gemini-2.5-flash",
                    contents: externalLinkSearchPrompt,
                    config: {
                        tools: [{googleSearch: {}}],
                    },
                });
                
                const externalSources = externalSearchResponse.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
                console.log(`📊 Dedicated external link search found ${externalSources.length} sources`);
                
                // Validate these sources
                for (const source of externalSources) {
                    if (source.web && source.web.uri && topicalExternalLinks.length < 6) {
                        const url = source.web.uri;
                        
                        // CRITICAL FIX: Filter out Google redirect URLs that expire
                        if (url.includes('grounding-api-redirect') || url.includes('vertexaisearch.cloud.google.com')) {
                            console.log(`🚫 Skipping Google redirect URL in dedicated search: ${url.substring(0, 80)}...`);
                            continue;
                        }
                        
                        try {
                            const isValid = await validateUrlExists(url);
                            if (isValid) {
                                topicalExternalLinks.push(url);
                                console.log(`✅ Added dedicated search link: ${url}`);
                            }
                        } catch (error) {
                            console.log(`❌ Invalid dedicated link: ${url}`);
                        }
                    }
                }
            }
            
        } catch (topicalError) {
            console.log('Failed to fetch topical external links:', topicalError.message);
        }

        // ENHANCED: Real-time page discovery for deep linking
        if (topicalExternalLinks.length < 3) {
            console.warn(`⚠️ Only ${topicalExternalLinks.length} topical links available (Google redirects filtered), performing real-time page discovery...`);
            
            // Get verified root domains for deep link discovery
            const verifiedLinks = getVerifiedExternalLinks(client.industry);
            console.log(`🔍 Starting real-time page discovery on ${verifiedLinks.length} verified domains for topic: "${plan.title}"`);
            
            // Discover deep links from verified domains
            for (const rootDomain of verifiedLinks.slice(0, 4)) { // Limit to 4 domains for performance
                if (topicalExternalLinks.length >= 6) break; // Stop when we have enough links
                
                try {
                    console.log(`🕷️ Discovering pages on ${rootDomain} relevant to "${plan.title}"`);
                    const deepLinks = await discoverRelevantPages(rootDomain, plan.title, client.industry);
                    
                    for (const deepLink of deepLinks) {
                        if (!topicalExternalLinks.includes(deepLink) && topicalExternalLinks.length < 6) {
                            topicalExternalLinks.push(deepLink);
                            console.log(`✅ Added deep link: ${deepLink}`);
                        }
                    }
                    
                    // Add root domain as fallback if no deep links found
                    if (deepLinks.length === 0 && !topicalExternalLinks.includes(rootDomain)) {
                        topicalExternalLinks.push(rootDomain);
                        console.log(`🔄 Added root domain fallback: ${rootDomain}`);
                    }
                    
                } catch (discoveryError) {
                    console.log(`⚠️ Page discovery failed for ${rootDomain}, using root domain: ${discoveryError.message}`);
                    if (!topicalExternalLinks.includes(rootDomain)) {
                        topicalExternalLinks.push(rootDomain);
                    }
                }
            }
            
            console.log(`📊 Real-time discovery complete: ${topicalExternalLinks.length} total external links`);
        }

        // Ensure we have the external links available for the content prompt
        console.log(`📋 Final external links for content generation: ${topicalExternalLinks.length} URLs`);
        topicalExternalLinks.forEach((url, index) => {
            console.log(`   ${index + 1}. ${url}`);
        });

        const internalLinksContext = internalLinks.length > 0 
            ? `\nAvailable Internal Links (use these EXACT templates, maximum ONE use per template):
               ${internalLinks.map((link, index) => 
                 `${index + 1}. Template: {{LINK_${index + 1}}}
                    Page Title: "${link.title}"
                    What it's about: ${link.description || 'Blog/page content'}
                    Category: ${link.category || 'general'}
                    Keywords: ${link.keywords || 'N/A'}
               `).join('\n')}
               
               🚨 CRITICAL LINKING RULES: 
               - Use EXACT templates shown above: {{LINK_1}}, {{LINK_2}}, etc.
               - Format: <a href="{{LINK_1}}">descriptive anchor text</a>
               - Maximum ONE use per template - NO EXCEPTIONS
               - Only link when there is GENUINE topical relevance
               - Choose 2-4 most relevant templates for your content
               - Anchor text must describe what the linked page is about
               - NEVER create your own URLs - only use the templates provided`
            : '\nNo internal links available yet - do not create any internal links.';

        // Step 4: Generate Complete Blog Content
        const contentStyleContext = createContentStyleContext(internalLinks);
        
        // Create external links context with discovered deep links
        const externalLinksContext = topicalExternalLinks.length > 0 
            ? `\n🚀 MANDATORY EXTERNAL LINKS - REAL-TIME DISCOVERED & VALIDATED:
            These URLs were discovered in real-time and validated specifically for your topic: "${plan.title}"
            ✅ YOU MUST USE 3-6 OF THESE VALIDATED URLS (they are guaranteed to work):
            ${topicalExternalLinks.map((url, index) => `${index + 1}. ${url} ← VALIDATED & TOPIC-RELEVANT`).join('\n            ')}
            
            🚨 CRITICAL REQUIREMENT:
            - YOU MUST INCLUDE AT LEAST 3-4 EXTERNAL LINKS FROM THE LIST ABOVE
            - These links were specifically discovered for your topic
            - All links have been validated and are guaranteed to work
            - Format: <a href="EXACT_URL_FROM_LIST" target="_blank" rel="noopener noreferrer">descriptive anchor text</a>
            - Distribute links naturally throughout your content
            - Each link provides genuine value related to "${plan.title}"
            
            EXAMPLES OF CORRECT USAGE:
            - "According to <a href="https://www.bbc.com/innovation" target="_blank" rel="noopener noreferrer">BBC Innovation</a> coverage..."
            - "Recent <a href="https://www.census.gov" target="_blank" rel="noopener noreferrer">U.S. Census data</a> shows..."
            
            ❌ CONTENT WILL BE REJECTED IF YOU DON'T INCLUDE EXTERNAL LINKS FROM THE LIST ABOVE`
            : '\n⚠️ No external links available - do not include any external links.';
        
        const contentPrompt = `
            You are an expert content writer for a company in the '${client.industry}' industry.
            Company's unique value proposition: '${client.uniqueValueProp}'
            Company's brand voice: '${client.brandVoice}'
            Company's content strategy: '${client.contentStrategy}'
            ${contentStyleContext}
            
            Write a complete blog post based on:
            Topic: ${topic}
            Title: ${plan.title}
            Angle: ${plan.angle}
            Target Keywords: ${plan.keywords.join(', ')}
            ${internalLinksContext}
            ${externalLinksContext}
            
            Requirements:
            - Write in HTML format with proper headings (h1, h2, h3)
            - Include the target keywords naturally throughout
            - Write in the company's brand voice
            - Make it engaging and valuable for readers
            - Include a compelling introduction and strong conclusion
            - Aim for 1500-2500 words
            
            CRITICAL PARAGRAPH FORMATTING RULES:
            - Follow the 2-4 sentence rule: Each paragraph should be 2-4 sentences maximum
            - One idea per paragraph: Each paragraph focuses on a single, distinct point
            - Use single-sentence paragraphs for emphasis, transitions, or questions
            - Think mobile-first: Paragraphs that look good on desktop must work on smartphones
            - Create white space: Short paragraphs improve readability and reduce eye strain
            - Break up dense content: If a paragraph looks too long, split it up
            - Use bulleted lists when appropriate instead of long paragraphs
            
            PARAGRAPH EXAMPLES:
            ✅ GOOD (2-4 sentences, one idea):
            "Good SEO helps potential customers find you through search engines. It involves optimizing your site's structure, content, and authority. By ranking higher for relevant keywords, you attract qualified traffic. This leads to more leads and sales for your business."
            
            ❌ BAD (wall of text):
            "Good SEO is the practice of helping potential customers find you through search engines because it involves optimizing your site's structure, content, and overall authority so that you can rank higher for the keywords that people are searching for..."
            
            ✅ SINGLE-SENTENCE PARAGRAPH for emphasis:
            "This is the key point that changes everything."
            
            Remember: Mobile users will see longer paragraphs as intimidating blocks of text.
            - INTERNAL LINKING RULES:
              * CRITICAL: Use ONLY the template placeholders provided: {{LINK_1}}, {{LINK_2}}, etc.
              * MAXIMUM ONE use per template - NEVER use the same template twice
              * Only link when there is a GENUINE contextual connection to the topic
              * Be VERY SELECTIVE - only 2-4 truly relevant templates, not forced linking
              * Use anchor text that EXACTLY matches what the linked page is about
              * Links must feel NATURAL and provide real value to readers
              * Format links as: <a href="{{LINK_1}}">precise descriptive anchor text</a>
              * EXAMPLE: <a href="{{LINK_2}}">auto insurance coverage</a>
              * NEVER create your own URLs or modify templates
              * If no templates are genuinely relevant to your topic, use fewer links or none
              * Quality over quantity - better to have 2 perfect links than 6 poor ones

            - CRITICAL: Only reference actual websites that exist and provide genuine information
            - NEVER create fictional URLs or hypothetical websites
            - PRIORITIZE THESE REAL AUTHORITATIVE SOURCES BY INDUSTRY:
              * Government sites (.gov domains) - use REAL government websites only
              * Industry associations and professional organizations (HIGHEST PRIORITY) - use REAL organizations
              * Major news publications: reuters.com, bbc.com, wsj.com, bloomberg.com, cnbc.com
              * Established research institutions and universities (.edu domains) - use REAL universities
              * Recognized industry publications and trade websites - use REAL publications only
              * Wikipedia (en.wikipedia.org) ONLY as absolute last resort for basic definitions
            - Links must be contextually integrated into the content naturally
            - Use descriptive, keyword-rich anchor text that accurately reflects the linked content
            - Format: <a href="URL" target="_blank" rel="noopener noreferrer">descriptive anchor text</a>
            - NEVER create fictional URLs or hypothetical websites
            - Only link to sources that genuinely provide the information referenced in your anchor text
            - EXAMPLES OF GOOD EXTERNAL LINKS (prioritize industry sources):
              * "The <a href=\"https://www.naic.org\" target=\"_blank\" rel=\"noopener noreferrer\">National Association of Insurance Commissioners</a> reports that..."
              * "According to <a href=\"https://www.iii.org\" target=\"_blank\" rel=\"noopener noreferrer\">Insurance Information Institute data</a>, claims have increased..."
              * "Recent <a href=\"https://www.reuters.com\" target=\"_blank\" rel=\"noopener noreferrer\">Reuters analysis</a> shows industry trends..."
              * "The <a href=\"https://www.osha.gov\" target=\"_blank\" rel=\"noopener noreferrer\">Occupational Safety and Health Administration</a> recommends..."
            - AVOID: Multiple Wikipedia links, generic definitions, irrelevant sources
            - Distribute links throughout the article naturally within relevant sentences
            - AVOID Wikipedia unless no other source exists for basic definitions
            - PRIORITIZE THESE AUTHORITATIVE SOURCES FOR ${client.industry.toUpperCase()} INDUSTRY:
              ${getIndustryAuthoritativeSources(client.industry).map(source => `* ${source} (USE THESE FIRST)`).join('\n              ')}
            - USE THESE INDUSTRY SOURCES BEFORE considering general sources like Wikipedia
            - Each external link should reference specific information, studies, or expert opinions
            
            FAQ REQUIREMENTS:
            - Generate 2-8 relevant FAQs based on the blog content
            - Questions should address common concerns readers might have about the topic
            - Answers should be comprehensive but concise (2-4 sentences each)
            - Focus on practical, actionable information
            - Use industry-specific terminology appropriately
            - Questions should naturally arise from the blog content and provide additional value
        `;
        
        const contentResponse = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: contentPrompt,
            config: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        content: { type: Type.STRING, description: 'Complete blog post content in HTML format.' },
                        wordCount: { type: Type.NUMBER, description: 'Actual word count of the content.' },
                        metaDescription: { type: Type.STRING, description: 'SEO meta description (150-160 characters).' },
                        faqs: {
                            type: Type.ARRAY,
                            items: {
                                type: Type.OBJECT,
                                properties: {
                                    question: { type: Type.STRING, description: 'FAQ question' },
                                    answer: { type: Type.STRING, description: 'FAQ answer (2-4 sentences)' }
                                },
                                required: ["question", "answer"]
                            },
                            description: 'Array of 2-8 relevant FAQs'
                        }
                    },
                    required: ["content", "wordCount", "metaDescription", "faqs"]
                },
            },
        });
        
        const contentData = JSON.parse(contentResponse.text);

        // CRITICAL: Replace URL templates with actual URLs
        console.log('🔧 Applying template-based URL replacement to lucky blog content...');
        contentData.content = replaceUrlTemplatesWithReal(contentData.content, internalLinks);
        
        // Validate internal links in lucky blog content
        validateInternalLinks(contentData.content, internalLinks);
        
        // Validate external links in lucky blog content
        await validateExternalLinks(contentData.content);

        // Step 5: Wait for Parallel Image Generation and Upload
        console.log(`🖼️ Step 5: Waiting for parallel image generation to complete...`);
        let featuredImageId = null;
        
        try {
            // Wait for the parallel image generation to complete
            console.log(`⏳ Awaiting image promise...`);
            const imageData = await imagePromise;
            console.log(`📊 Image promise resolved:`, imageData ? 'SUCCESS' : 'NULL');
            
            if (imageData && imageData.imageBase64) {
                console.log(`✅ Image generation completed, uploading to WordPress...`);
                console.log(`📏 Image data size: ${imageData.imageBase64.length} characters (base64)`);
                
                const filename = `featured-${plan.title.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()}.jpg`;
                console.log(`📁 Upload filename: ${filename}`);
                
                const uploadedImage = await uploadImageToWordPress(
                    imageData.imageBase64,
                    filename,
                    imageData.altText,
                    client
                );
                
                featuredImageId = uploadedImage.id;
                console.log(`✅ Featured image uploaded successfully: ID=${featuredImageId}, URL=${uploadedImage.url}`);
            } else {
                console.warn(`⚠️ No image data available from parallel generation`);
                console.warn(`📊 ImageData object:`, imageData);
                console.warn(`🔧 Possible causes: OpenAI API key missing, generation failed, or network error`);
            }
            
        } catch (imageError) {
            console.error('❌ Failed to process/upload featured image:', imageError);
            console.error('🔍 Error details:', {
                message: imageError.message,
                stack: imageError.stack?.split('\n').slice(0, 3).join('\n')
            });
            // Continue without featured image rather than failing the whole process
        }

        // Step 6: Create WordPress Draft
        console.log(`📝 Creating WordPress draft for "${plan.title}"`);
        
        // Handle tags - convert tag names to IDs or create new tags
        let tagIds = [];
        if (plan.keywords && plan.keywords.length > 0) {
            for (const tagName of plan.keywords) {
                try {
                    // First, try to find existing tag
                    const tagSearchUrl = `${client.wp.url.replace(/\/$/, '')}/wp-json/wp/v2/tags?search=${encodeURIComponent(tagName)}`;
                    const tagSearchResponse = await fetch(tagSearchUrl, {
                        headers: {
                            'Authorization': `Basic ${Buffer.from(`${client.wp.username}:${client.wp.appPassword}`).toString('base64')}`
                        }
                    });
                    
                    if (tagSearchResponse.ok) {
                        const existingTags = await tagSearchResponse.json();
                        const existingTag = existingTags.find(tag => tag.name.toLowerCase() === tagName.toLowerCase());
                        
                        if (existingTag) {
                            tagIds.push(existingTag.id);
                        } else {
                            // Create new tag
                            const tagCreateUrl = `${client.wp.url.replace(/\/$/, '')}/wp-json/wp/v2/tags`;
                            const tagCreateResponse = await fetch(tagCreateUrl, {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                    'Authorization': `Basic ${Buffer.from(`${client.wp.username}:${client.wp.appPassword}`).toString('base64')}`
                                },
                                body: JSON.stringify({ name: tagName })
                            });
                            
                            if (tagCreateResponse.ok) {
                                const newTag = await tagCreateResponse.json();
                                tagIds.push(newTag.id);
                            }
                        }
                    }
                } catch (tagError) {
                    console.log(`Failed to process tag "${tagName}":`, tagError.message);
                }
            }
        }

        // Generate FAQ HTML with schema markup
        const faqHTML = generateFAQHTML(contentData.faqs);
        
        // Combine main content with FAQ section
        let fullContent = contentData.content + faqHTML;
        
        // Add Open Graph meta tags if featured image is available
        if (featuredImageId) {
            try {
                const mediaResponse = await fetch(`${client.wp.url.replace(/\/$/, '')}/wp-json/wp/v2/media/${featuredImageId}`, {
                    headers: {
                        'Authorization': `Basic ${Buffer.from(`${client.wp.username}:${client.wp.appPassword}`).toString('base64')}`
                    }
                });
                
                if (mediaResponse.ok) {
                    const mediaData = await mediaResponse.json();
                    const imageUrl = mediaData.source_url;
                    
                    const openGraphTags = generateOpenGraphTags(
                        plan.title,
                        contentData.metaDescription || `Professional ${client.industry} insights from ${client.name}`,
                        imageUrl,
                        `${client.wp.url}`,
                        client.name
                    );
                    
                    fullContent = openGraphTags + fullContent;
                    console.log(`🌐 Added Open Graph meta tags with featured image: ${imageUrl}`);
                }
            } catch (ogError) {
                console.warn('⚠️ Failed to add Open Graph tags:', ogError.message);
            }
        }
        
        // Prepare post data for draft publication
        const postData = {
            title: plan.title,
            content: fullContent,
            excerpt: contentData.metaDescription || '',
            status: 'draft', // Always draft for review
            tags: tagIds
        };
        
        // Add featured image if uploaded successfully
        if (featuredImageId) {
            postData.featured_media = featuredImageId;
            console.log(`🖼️ Setting featured image ID: ${featuredImageId}`);
        }
        
        const wpApiUrl = `${client.wp.url.replace(/\/$/, '')}/wp-json/wp/v2/posts`;
        
        // Enhanced WordPress API call with WordFence compatibility
        console.log('📝 Creating WordPress post...');
        console.log('🔗 WordPress API URL:', wpApiUrl);
        console.log('📊 Post data:', { 
            title: postData.title, 
            contentLength: postData.content.length, 
            status: postData.status,
            hasFeaturedMedia: !!postData.featured_media 
        });
        
        const wpResponse = await fetch(wpApiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Basic ${Buffer.from(`${client.wp.username}:${client.wp.appPassword}`).toString('base64')}`
            },
            body: JSON.stringify(postData)
        });
        
        console.log('📊 WordPress API response status:', wpResponse.status);
        console.log('📋 WordPress API response headers:', Object.fromEntries(wpResponse.headers.entries()));

        if (!wpResponse.ok) {
            const errorText = await wpResponse.text();
            console.error('❌ WordPress publishing failed:', errorText);
            console.error('📊 Response status:', wpResponse.status);
            console.error('📋 Response headers:', Object.fromEntries(wpResponse.headers.entries()));
            
            // WordFence-specific error handling
            let errorMessage = `WordPress publishing failed: ${wpResponse.status} ${wpResponse.statusText}`;
            let suggestions = [];
            
            if (wpResponse.status === 403) {
                errorMessage = '🛡️ WordPress API access FORBIDDEN - WordFence is likely blocking the request';
                suggestions = [
                    'Go to WordFence → All Options → Brute Force Protection',
                    'Ensure "Disable WordPress application passwords" is UNCHECKED',
                    'Check WordFence → Tools → Live Traffic for blocked requests',
                    'Add Blog MONKEE IP to WordFence allowlist',
                    'Verify REST API is enabled: Settings → Permalinks → Save',
                    'Check user has publish_posts capability'
                ];
            } else if (wpResponse.status === 401) {
                errorMessage = '🔐 WordPress authentication failed';
                suggestions = [
                    'Verify WordPress username and app password are correct',
                    'Check if Application Passwords are enabled',
                    'Ensure user has sufficient permissions to create posts',
                    'Try regenerating the Application Password'
                ];
            } else if (wpResponse.status === 429) {
                errorMessage = '⏱️ Rate limit exceeded - WordFence is throttling requests';
                suggestions = [
                    'Check WordFence rate limiting settings',
                    'Add Blog MONKEE to WordFence trusted sources',
                    'Wait 5-10 minutes before trying again',
                    'Check WordFence → All Options → Rate Limiting'
                ];
            } else if (wpResponse.status >= 500) {
                errorMessage = '🔥 WordPress server error';
                suggestions = [
                    'Check WordPress site is accessible and healthy',
                    'Review WordPress error logs in cPanel/hosting',
                    'Verify server resources and PHP memory limits',
                    'Check for plugin conflicts'
                ];
            }
            
            console.error('💡 WordFence Troubleshooting Suggestions:');
            suggestions.forEach(suggestion => console.error(`   - ${suggestion}`));
            
            throw new Error(`${errorMessage}. Response: ${errorText}`);
        }

        const wpPost = await wpResponse.json();

        // Store the published topic to avoid duplicates
        try {
            await pool.query(
                'INSERT INTO used_topics (client_id, topic) VALUES ($1, $2)',
                [clientId, plan.title]
            );
        } catch (topicError) {
            console.log('Topic already exists or error storing:', topicError.message);
        }

        // Auto-update: Add published blog to sitemap database for future internal linking
        await addBlogToSitemapDatabase(clientId, wpPost.link, plan.title, contentData.metaDescription || 'Generated blog post');

        // Cleanup topical external links to prevent reuse
        try {
            const cleanupResult = await pool.query(
                'DELETE FROM topic_external_links WHERE client_id = $1 AND topic = $2',
                [clientId, plan.title]
            );
            console.log(`🧹 Cleaned up ${cleanupResult.rowCount} topical external links for "${plan.title}"`);
        } catch (cleanupError) {
            console.log('⚠️ Failed to cleanup topical links:', cleanupError.message);
        }

        console.log(`🎉 LUCKY SUCCESS: "${plan.title}" created as draft at ${wpPost.link}`);

        // Return complete success data
        res.json({
            success: true,
            topic: topic,
            sources: sources,
            plan: plan,
            content: contentData,
            publishResult: {
                success: true,
                postId: wpPost.id,
                postUrl: wpPost.link,
                editUrl: wpPost.link ? wpPost.link.replace(/\/$/, '') + '/wp-admin/post.php?post=' + wpPost.id + '&action=edit' : null,
                status: 'draft',
                message: '🍀 Lucky! Blog post generated and created as draft for review!'
            },
            isLucky: true
        });

    } catch (error) {
        console.error('🍀 LUCKY MODE ERROR:', error);
        res.status(500).json({ 
            error: 'Lucky mode failed', 
            details: error.message,
            isLucky: true
        });
    }
});


// Start server
app.listen(port, () => {
  console.log(`Blog MONKEE backend listening at http://localhost:${port}`);
  console.log('🔄 Database migration version: v2.0 - Enhanced crawling support');
  initializeDb();
});