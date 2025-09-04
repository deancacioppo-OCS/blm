import React, { useState } from 'react';
import { Client } from '../types';
import * as api from '../services/geminiService';
import Spinner from './Spinner';

interface ClientFormModalProps {
  client: Client | null;
  onClose: () => void;
  onSave: (client: Client) => void;
}

const ClientFormModal: React.FC<ClientFormModalProps> = ({ client, onClose, onSave }) => {
  const [formData, setFormData] = useState<Partial<Client>>(
    client || {
      name: '',
      industry: '',
      websiteUrl: '',
      sitemapUrl: '',
      uniqueValueProp: '',
      brandVoice: '',
      contentStrategy: '',
      ghlLocationId: '',
      wp: { url: '', username: '' }
    }
  );
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    if (name.startsWith('wp.')) {
        const wpField = name.split('.')[1];
        setFormData(prev => ({ ...prev, wp: { ...prev.wp, [wpField]: value } }));
    } else {
        setFormData(prev => ({ ...prev, [name]: value }));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);
    try {
      // Basic validation
      if (!formData.name || !formData.industry) {
        throw new Error("Company Name and Industry are required.");
      }
      const savedClient = await api.saveClient(formData as Client);
      onSave(savedClient);
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to save client.');
    } finally {
      setIsLoading(false);
    }
  };
  
  const formTitle = client ? 'Edit Client' : 'Add New Client';

  return (
    <div 
        className="fixed inset-0 bg-black bg-opacity-70 flex justify-center items-center z-50"
        onClick={onClose}
        aria-modal="true"
        role="dialog"
    >
      <div 
        className="bg-slate-800 rounded-lg shadow-2xl p-8 w-full max-w-2xl max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <h2 className="text-2xl font-bold mb-6 text-cyan-400">{formTitle}</h2>
        
        {error && <div className="bg-red-800 text-red-200 p-3 rounded-md mb-4">{error}</div>}
        
        <form onSubmit={handleSubmit} className="space-y-4">
            <InputField label="Company Name" name="name" value={formData.name || ''} onChange={handleChange} required />
            <InputField label="Industry" name="industry" value={formData.industry || ''} onChange={handleChange} required />
            <InputField label="Website URL" name="websiteUrl" value={formData.websiteUrl || ''} onChange={handleChange} type="url" />
            <InputField label="XML Sitemap URL" name="sitemapUrl" value={formData.sitemapUrl || ''} onChange={handleChange} type="url" placeholder="https://yoursite.com/sitemap.xml" />

            <h3 className="text-lg font-semibold text-slate-300 pt-4 border-t border-slate-700">Brand Details</h3>
            <TextareaField label="Unique Value Proposition" name="uniqueValueProp" value={formData.uniqueValueProp || ''} onChange={handleChange} />
            <TextareaField label="Brand Voice" name="brandVoice" value={formData.brandVoice || ''} onChange={handleChange} />
            <TextareaField label="Content Strategy" name="contentStrategy" value={formData.contentStrategy || ''} onChange={handleChange} />

            <h3 className="text-lg font-semibold text-slate-300 pt-4 border-t border-slate-700">SEO & Internal Linking</h3>
            <div className="text-sm text-slate-400 p-3 bg-slate-700 rounded-md">
                <p className="font-medium mb-2">🗺️ XML Sitemap Parsing (Recommended)</p>
                <p>Provide your XML sitemap URL for comprehensive page discovery. This is much faster and more complete than AI crawling - it gets every page you want indexed! Each published blog will automatically be added to the internal links database.</p>
                <p className="mt-2 text-xs text-cyan-400">💡 Tip: Usually found at yoursite.com/sitemap.xml or in robots.txt</p>
            </div>
            
            {/* Show sitemap test button if client exists and has sitemap URL */}
            {client?.id && formData.sitemapUrl && (
                <SitemapTestButton clientId={client.id} sitemapUrl={formData.sitemapUrl} />
            )}
            
            {/* Fallback: Show website crawl test button if no sitemap but has website URL */}
            {client?.id && !formData.sitemapUrl && formData.websiteUrl && (
                <WebsiteCrawlTestButton clientId={client.id} websiteUrl={formData.websiteUrl} />
            )}

            <h3 className="text-lg font-semibold text-slate-300 pt-4 border-t border-slate-700">WordPress Details</h3>
            <InputField label="WordPress Site URL" name="wp.url" value={formData.wp?.url || ''} onChange={handleChange} type="url" />
            <InputField label="WordPress Username" name="wp.username" value={formData.wp?.username || ''} onChange={handleChange} />
            <InputField label="WordPress App Password" name="wp.appPassword" value={formData.wp?.appPassword || ''} onChange={handleChange} type="password" />
            
            {/* WordPress Test Button - only show if client exists and has WP credentials */}
            {client?.id && formData.wp?.url && formData.wp?.username && formData.wp?.appPassword && (
                <WordPressTestButton clientId={client.id} />
            )}

            <h3 className="text-lg font-semibold text-slate-300 pt-4 border-t border-slate-700">Go High Level Integration</h3>
            <InputField 
                label="GHL Location ID" 
                name="ghlLocationId" 
                value={formData.ghlLocationId || ''} 
                onChange={handleChange} 
                placeholder="e.g., 1ALSPGdRmfymipcWOVU1"
            />
            <div className="text-sm text-slate-400 p-3 bg-slate-700 rounded-md">
                <p className="font-medium mb-2">📱 Google Business Profile Posting</p>
                <p>Enter the Go High Level Location ID for this client to enable automatic Google Business Profile posting. When you use "I'm Feelin' Lucky", the system will automatically post optimized content to their Google Business Profile.</p>
                <p className="mt-2 text-xs text-cyan-400">💡 Find this in your GHL dashboard under Settings → Locations</p>
            </div>

          <div className="flex justify-end gap-4 pt-4">
            <button type="button" onClick={onClose} className="py-2 px-4 bg-slate-600 hover:bg-slate-700 rounded-lg transition-colors">
              Cancel
            </button>
            <button type="submit" disabled={isLoading} className="py-2 px-4 bg-cyan-500 hover:bg-cyan-600 rounded-lg transition-colors disabled:bg-slate-500 disabled:cursor-not-allowed flex items-center gap-2">
              {isLoading && <Spinner />}
              {isLoading ? 'Saving...' : 'Save Client'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

// Helper sub-components for form fields
const InputField = ({ label, ...props }) => (
    <div>
        <label htmlFor={props.name} className="block text-sm font-medium text-slate-300 mb-1">{label}</label>
        <input id={props.name} {...props} className="w-full bg-slate-900 border border-slate-600 rounded-md p-2 focus:ring-cyan-500 focus:border-cyan-500 transition"/>
    </div>
);

const TextareaField = ({ label, ...props }) => (
    <div>
        <label htmlFor={props.name} className="block text-sm font-medium text-slate-300 mb-1">{label}</label>
        <textarea id={props.name} {...props} rows={3} className="w-full bg-slate-900 border border-slate-600 rounded-md p-2 focus:ring-cyan-500 focus:border-cyan-500 transition"></textarea>
    </div>
);

// WordPress Test Button Component
const WordPressTestButton = ({ clientId }) => {
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState(null);

    const handleTest = async () => {
        setTesting(true);
        setTestResult(null);
        try {
            const result = await api.testWordPressConnection(clientId);
            setTestResult(result);
        } catch (err) {
            setTestResult({ 
                success: false, 
                error: 'Connection test failed', 
                details: err.message 
            });
        } finally {
            setTesting(false);
        }
    };

    return (
        <div className="p-3 bg-slate-700 rounded-md">
            <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-slate-300">Test WordPress Connection</span>
                <button
                    type="button"
                    onClick={handleTest}
                    disabled={testing}
                    className="bg-blue-500 hover:bg-blue-600 text-white text-sm py-1 px-3 rounded transition-colors disabled:opacity-50 flex items-center gap-2"
                >
                    {testing && <Spinner small />}
                    {testing ? 'Testing...' : 'Test Connection'}
                </button>
            </div>
            
            {testResult && (
                <div className={`text-sm p-2 rounded ${testResult.success ? 'bg-green-800 text-green-200' : 'bg-red-800 text-red-200'}`}>
                    {testResult.success ? (
                        <div>
                            <p className="font-medium">✓ Connection successful!</p>
                            <p>Connected as: {testResult.user?.name} (@{testResult.user?.username})</p>
                        </div>
                    ) : (
                        <div>
                            <p className="font-medium">✗ Connection failed</p>
                            <p>{testResult.error}</p>
                            {testResult.details && <p className="text-xs mt-1">{testResult.details}</p>}
                            {testResult.suggestions && (
                                <ul className="text-xs mt-2 list-disc list-inside">
                                    {testResult.suggestions.map((suggestion, i) => (
                                        <li key={i}>{suggestion}</li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

// Website Crawl Test Button Component
const WebsiteCrawlTestButton = ({ clientId, websiteUrl }) => {
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState(null);

    const handleTest = async () => {
        setTesting(true);
        setTestResult(null);
        try {
            const result = await api.testWebsiteCrawling(clientId, websiteUrl);
            setTestResult(result);
        } catch (err) {
            setTestResult({ 
                success: false, 
                error: 'Website crawl test failed', 
                details: err.message 
            });
        } finally {
            setTesting(false);
        }
    };

    return (
        <div className="p-3 bg-slate-700 rounded-md mt-2">
            <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-slate-300">AI Website Crawling</span>
                <button
                    type="button"
                    onClick={handleTest}
                    disabled={testing}
                    className="bg-purple-500 hover:bg-purple-600 text-white text-sm py-1 px-3 rounded transition-colors disabled:opacity-50 flex items-center gap-2"
                >
                    {testing && <Spinner small />}
                    {testing ? 'Crawling...' : 'Crawl Website'}
                </button>
            </div>
            
            {testResult && (
                <div className={`text-sm p-2 rounded ${testResult.success ? 'bg-green-800 text-green-200' : 'bg-red-800 text-red-200'}`}>
                    {testResult.success ? (
                        <div>
                            <p className="font-medium">✓ Website crawled successfully!</p>
                            <p>AI discovered {testResult.crawl?.totalPagesFound} pages</p>
                            <p>Database has {testResult.database?.existingUrls} stored URLs</p>
                            {testResult.crawl?.samplePages && testResult.crawl.samplePages.length > 0 && (
                                <div className="mt-2">
                                    <p className="text-xs font-medium">Sample Pages:</p>
                                    <ul className="text-xs mt-1 list-disc list-inside">
                                        {testResult.crawl.samplePages.slice(0, 3).map((page, i) => (
                                            <li key={i} className="truncate">
                                                <span className="font-medium">{page.title}:</span> {page.url}
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                        </div>
                    ) : (
                        <div>
                            <p className="font-medium">✗ Website crawl test failed</p>
                            <p>{testResult.error}</p>
                            {testResult.details && <p className="text-xs mt-1">{testResult.details}</p>}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

// XML Sitemap Test Button Component
const SitemapTestButton = ({ clientId, sitemapUrl }) => {
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState(null);

    const handleTest = async () => {
        setTesting(true);
        setTestResult(null);
        try {
            const result = await api.testSitemapParsing(clientId, sitemapUrl);
            setTestResult(result);
        } catch (err) {
            setTestResult({ 
                success: false, 
                error: 'Sitemap parsing test failed', 
                details: err.message 
            });
        }
        setTesting(false);
    };

    return (
        <div className="border border-slate-600 p-4 rounded-md bg-slate-700">
            <div className="flex justify-between items-center mb-3">
                <h4 className="font-medium text-slate-200">🗺️ XML Sitemap Test</h4>
                <button
                    type="button"
                    onClick={handleTest}
                    disabled={testing}
                    className="bg-cyan-600 hover:bg-cyan-700 text-white px-3 py-1 rounded text-sm disabled:bg-slate-500 disabled:cursor-not-allowed flex items-center gap-2"
                >
                    {testing && <Spinner />}
                    {testing ? 'Testing...' : 'Test Sitemap'}
                </button>
            </div>

            {testResult && (
                <div className={`p-3 rounded-md text-sm ${testResult.success ? 'bg-green-800 text-green-200' : 'bg-red-800 text-red-200'}`}>
                    {testResult.success ? (
                        <div>
                            <p className="font-medium mb-2">✅ {testResult.message}</p>
                            <div className="grid grid-cols-3 gap-4 mb-3 text-xs">
                                <div><strong>Found:</strong> {testResult.parsing?.totalFound || 0} URLs</div>
                                <div><strong>Stored:</strong> {testResult.parsing?.stored || 0} URLs</div>
                                <div><strong>Total DB:</strong> {testResult.database?.totalUrls || 0} URLs</div>
                            </div>
                            <div className="mb-2">
                                <strong>🏆 Advantages:</strong>
                                <ul className="list-disc list-inside text-xs mt-1">
                                    {testResult.advantages?.map((advantage, index) => (
                                        <li key={index}>{advantage}</li>
                                    ))}
                                </ul>
                            </div>
                            {testResult.parsing?.samplePages && testResult.parsing.samplePages.length > 0 && (
                                <div>
                                    <strong>📄 Sample pages found:</strong>
                                    <ul className="list-disc list-inside text-xs mt-1 max-h-20 overflow-y-auto">
                                        {testResult.parsing.samplePages.slice(0, 5).map((page, index) => (
                                            <li key={index}>{page.url} - {page.title}</li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                        </div>
                    ) : (
                        <div>
                            <p className="font-medium">❌ {testResult.error}</p>
                            {testResult.details && <p className="text-xs mt-1">{testResult.details}</p>}
                            {testResult.suggestion && <p className="text-xs mt-1 text-yellow-200">💡 {testResult.suggestion}</p>}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

export default ClientFormModal;
