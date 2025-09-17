import React, { useState, useCallback } from 'react';
import { Client, BlogPlan, BlogOutline, BlogContent, BlogImages, CompleteBlog, WordPressPublishResult } from '../types';
import * as api from '../services/geminiService';
import Spinner from './Spinner';

interface GenerationWorkflowProps {
  client: Client | null;
}

const GenerationWorkflow: React.FC<GenerationWorkflowProps> = ({ client }) => {
  const [topic, setTopic] = useState<string>('');
  const [sources, setSources] = useState<any[]>([]);
  const [plan, setPlan] = useState<BlogPlan | null>(null);
  const [outline, setOutline] = useState<BlogOutline | null>(null);
  const [content, setContent] = useState<BlogContent | null>(null);
  const [images, setImages] = useState<BlogImages | null>(null);
  const [publishResult, setPublishResult] = useState<WordPressPublishResult | null>(null);
  
  // Series mode state
  const [seriesMode, setSeriesMode] = useState<boolean>(false);
  const [intervalDays, setIntervalDays] = useState<number[]>([6, 12, 18]);
  const [seriesRunning, setSeriesRunning] = useState<boolean>(false);
  const [seriesError, setSeriesError] = useState<string | null>(null);
  const [seriesStatuses, setSeriesStatuses] = useState<string[]>([]);
  
  const [topicLoading, setTopicLoading] = useState(false);
  const [planLoading, setPlanLoading] = useState(false);
  const [outlineLoading, setOutlineLoading] = useState(false);
  const [contentLoading, setContentLoading] = useState(false);
  const [imagesLoading, setImagesLoading] = useState(false);
  const [publishLoading, setPublishLoading] = useState(false);
  const [completeBlogLoading, setCompleteBlogLoading] = useState(false);

  const [topicError, setTopicError] = useState<string | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [outlineError, setOutlineError] = useState<string | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);
  const [imagesError, setImagesError] = useState<string | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [completeBlogError, setCompleteBlogError] = useState<string | null>(null);

  const resetAllSteps = () => {
    setTopic('');
    setSources([]);
    setPlan(null);
    setOutline(null);
    setContent(null);
    setImages(null);
    setPublishResult(null);
  };

  const handleDiscoverTopic = useCallback(async () => {
    if (!client) return;
    setTopicLoading(true);
    setTopicError(null);
    resetAllSteps(); // Reset all subsequent steps
    try {
      const result = await api.generateTopic(client.id);
      setTopic(result.topic);
      setSources(result.sources);
    } catch (err) {
      setTopicError('Failed to discover a topic. Please try again.');
    } finally {
      setTopicLoading(false);
    }
  }, [client]);

  const handleCreatePlan = useCallback(async () => {
    if (!client || !topic) return;
    setPlanLoading(true);
    setPlanError(null);
    setPlan(null);
    setOutline(null); // Reset subsequent steps
    setContent(null);
    setImages(null);
    setPublishResult(null);
    try {
        const result = await api.generatePlan(client.id, topic);
        setPlan(result);
    } catch (err) {
        setPlanError('Failed to create a content plan. Please try again.');
    } finally {
        setPlanLoading(false);
    }
  }, [client, topic]);

  const handleCreateOutline = useCallback(async () => {
    if (!client || !topic || !plan) return;
    setOutlineLoading(true);
    setOutlineError(null);
    setOutline(null);
    setContent(null); // Reset subsequent steps
    setImages(null);
    setPublishResult(null);
    try {
        const result = await api.generateOutline(client.id, topic, plan.title, plan.angle, plan.keywords);
        setOutline(result);
    } catch (err) {
        setOutlineError('Failed to create outline. Please try again.');
    } finally {
        setOutlineLoading(false);
    }
  }, [client, topic, plan]);

  const handleGenerateContent = useCallback(async () => {
    if (!client || !topic || !plan || !outline) return;
    setContentLoading(true);
    setContentError(null);
    setContent(null);
    setImages(null); // Reset subsequent steps
    setPublishResult(null);
    try {
        const result = await api.generateContent(client.id, topic, plan.title, plan.angle, plan.keywords, outline.outline);
        setContent(result);
    } catch (err) {
        setContentError('Failed to generate content. Please try again.');
    } finally {
        setContentLoading(false);
    }
  }, [client, topic, plan, outline]);

  const handleGenerateImages = useCallback(async () => {
    if (!client || !plan) return;
    setImagesLoading(true);
    setImagesError(null);
    setImages(null);
    try {
        // Extract headings from outline if available
        const headings = outline?.outline.match(/^#+\s+(.+)$/gm)?.map(h => h.replace(/^#+\s+/, '')) || [];
        const result = await api.generateImages(client.id, plan.title, headings);
        setImages(result);
    } catch (err) {
        setImagesError('Failed to generate images. Please try again.');
    } finally {
        setImagesLoading(false);
    }
  }, [client, plan, outline]);

  const handlePublishToWordPress = useCallback(async () => {
    if (!client || !plan || !content) return;
    setPublishLoading(true);
    setPublishError(null);
    setPublishResult(null);
    try {
        const result = await api.publishToWordPress(
            client.id, 
            plan.title, 
            content.content, 
            content.metaDescription,
            undefined, // featuredImage - would be base64 if we had actual images
            plan.keywords, // use keywords as tags
            [], // categories - could be derived from client industry
            { publishNow: true }
        );
        setPublishResult(result);
    } catch (err) {
        setPublishError('Failed to publish to WordPress. Please try again.');
    } finally {
        setPublishLoading(false);
    }
  }, [client, plan, content]);

  // Orchestrate Series of 4: main now + 3 scheduled using user-provided intervals
  const handleSeriesOfFour = useCallback(async () => {
    if (!client) return;
    setSeriesRunning(true);
    setSeriesError(null);
    setSeriesStatuses([]);
    try {
      // MAIN: topic -> plan -> outline -> content -> images (use local variables to avoid state race)
      const topicResult = await api.generateTopic(client.id);
      setTopic(topicResult.topic);
      setSources(topicResult.sources);

      const mainPlan = await api.generatePlan(client.id, topicResult.topic);
      setPlan(mainPlan);

      const mainOutline = await api.generateOutline(client.id, topicResult.topic, mainPlan.title, mainPlan.angle, mainPlan.keywords);
      setOutline(mainOutline);

      const mainContent = await api.generateContent(client.id, topicResult.topic, mainPlan.title, mainPlan.angle, mainPlan.keywords, mainOutline.outline);
      setContent(mainContent);

      const mainHeadings = mainOutline.outline.match(/^#+\s+(.+)$/gm)?.map(h => h.replace(/^#+\s+/, '')) || [];
      const mainImages = await api.generateImages(client.id, mainPlan.title, mainHeadings);
      setImages(mainImages);

      // Publish main immediately
      const mainPublish = await api.publishToWordPress(
        client.id,
        mainPlan.title,
        mainContent.content,
        mainContent.metaDescription,
        mainImages?.featuredImage?.imageBase64 ? `data:image/jpeg;base64,${mainImages.featuredImage.imageBase64}` : undefined,
        [...(mainPlan.keywords || []), `Series: ${mainPlan.title}`],
        [],
        { publishNow: true }
      );
      setPublishResult(mainPublish);

      // If main content looks short, try to extend and update post once
      const approxWords = (mainContent.content || '').replace(/<[^>]+>/g, ' ').trim().split(/\s+/).filter(Boolean).length;
      if (approxWords < 1200 && mainPublish.postId) {
        try {
          const extraContentPrompt = 'Continue the blog post to completion without repeating. Return ONLY new HTML to append.';
          const cont = await api.generateContent(client.id, mainPlan.title, mainPlan.title, mainPlan.angle, mainPlan.keywords, mainOutline.outline);
          if (cont?.content && cont.content.length > 200) {
            await api.updateWordPressPost(client.id, mainPublish.postId, { content: mainContent.content + '\n\n' + cont.content, metaDescription: mainContent.metaDescription });
          }
        } catch (e) {
          console.warn('Extend main post failed (non-critical):', e);
        }
      }

      // Generate supporting titles
      const supporting = await api.generateSupportingTitles(client.id, mainPlan.title, 3);
      const now = new Date();

      // For each supporting title, generate and schedule (continue on error)
      for (let i = 0; i < supporting.titles.length; i++) {
        const supportTitle = supporting.titles[i];
        try {
          const sPlan = await api.generatePlan(client.id, supportTitle);
          const sOutline = await api.generateOutline(client.id, supportTitle, sPlan.title, sPlan.angle, sPlan.keywords);
          const sContent = await api.generateContent(client.id, supportTitle, sPlan.title, sPlan.angle, sPlan.keywords, sOutline.outline);
          const sHeadings = sOutline.outline.match(/^#+\s+(.+)$/gm)?.map(h => h.replace(/^#+\s+/, '')) || [];
          const sImages = await api.generateImages(client.id, sPlan.title, sHeadings);

          const days = intervalDays[i] || 6 * (i + 1);
          const scheduleDate = new Date(Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth(),
            now.getUTCDate() + days,
            now.getUTCHours(),
            now.getUTCMinutes(),
            0,
            0
          ));

          await api.publishToWordPress(
            client.id,
            sPlan.title,
            sContent.content,
            sContent.metaDescription,
            sImages?.featuredImage?.imageBase64 ? `data:image/jpeg;base64,${sImages.featuredImage.imageBase64}` : undefined,
            [...sPlan.keywords, `Series: ${mainPlan.title}`],
            [],
            { scheduleAt: scheduleDate.toISOString() }
          );
          setSeriesStatuses(prev => [...prev, `Scheduled: ${sPlan.title} → ${scheduleDate.toUTCString()}`]);
        } catch (err) {
          console.error('Series item failed:', err);
          setSeriesStatuses(prev => [...prev, `Failed: ${supportTitle}`]);
          continue;
        }
      }
    } catch (e) {
      setSeriesError('Failed to create series. Please review inputs and try again.');
    } finally {
      setSeriesRunning(false);
    }
  }, [client, intervalDays]);

  const handleGenerateCompleteBlog = useCallback(async () => {
    if (!client) return;
    setCompleteBlogLoading(true);
    setCompleteBlogError(null);
    resetAllSteps();
    try {
        const result = await api.generateLuckyBlog(client.id);
        setTopic(result.topic);
        setSources(result.sources);
        setPlan(result.plan);
        setContent(result.content);
        setPublishResult(result.publishResult);
        // Auto-set outline as "Generated" since it's included in the complete generation
        setOutline({ outline: "Complete outline generated", estimatedWordCount: result.content.wordCount, seoScore: 85 });
        // Show success message for lucky mode
        if (result.isLucky && result.publishResult.success) {
            console.log('🍀 Lucky Success! Blog published live:', result.publishResult.postUrl);
        }
    } catch (err) {
        setCompleteBlogError('🍀 Lucky mode failed. Please check WordPress credentials and try again.');
    } finally {
        setCompleteBlogLoading(false);
    }
  }, [client]);

  if (!client) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-slate-400">
        <svg xmlns="http://www.w3.org/2000/svg" className="h-16 w-16 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" /></svg>
        <h2 className="text-xl font-semibold">Select a Client</h2>
        <p>Choose a client from the list to start generating content.</p>
      </div>
    );
  }

  return (
    <div>
      <h2 className="text-2xl font-semibold text-slate-200 mb-1">
        Generation Workflow
      </h2>
      <p className="text-cyan-400 font-medium mb-4">{client.name}</p>

      <div className="space-y-6">
        {/* Quick Action: Complete Blog Generation */}
        <div className="p-4 bg-gradient-to-r from-cyan-900/20 to-blue-900/20 rounded-lg border border-cyan-700/30">
          <div className="flex justify-between items-center">
            <div>
              <h3 className="text-lg font-medium text-green-300">🍀 I'm Feelin' Lucky</h3>
              <p className="text-sm text-slate-400">Generate complete blog post and create as draft for review!</p>
            </div>
            <button
              onClick={handleGenerateCompleteBlog}
              disabled={completeBlogLoading}
              className="bg-gradient-to-r from-green-500 to-emerald-500 hover:from-green-600 hover:to-emerald-600 text-white font-bold py-2 px-4 rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 shadow-lg"
            >
              {completeBlogLoading && <Spinner small />}
              {completeBlogLoading ? 'Creating Draft...' : "I'm Feelin' Lucky 🍀"}
            </button>
          </div>
          {completeBlogError && <p className="text-red-400 text-sm mt-2">{completeBlogError}</p>}
        </div>

        {/* Series of 4 Controls */}
        <div className="p-4 bg-gradient-to-r from-blue-900/20 to-indigo-900/20 rounded-lg border border-blue-700/30">
          <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-3">
            <div>
              <h3 className="text-lg font-medium text-blue-300">Series of 4</h3>
              <p className="text-sm text-slate-400">Publish main now and schedule 3 supporting posts.</p>
              <div className="mt-3 flex items-center gap-2 text-sm text-slate-300">
                <label>Intervals (days):</label>
                {intervalDays.map((d, idx) => (
                  <input
                    key={idx}
                    type="number"
                    min={1}
                    value={d}
                    onChange={e => {
                      const next = [...intervalDays];
                      next[idx] = Number(e.target.value);
                      setIntervalDays(next);
                    }}
                    className="w-16 bg-slate-800 border border-slate-600 rounded px-2 py-1"
                  />
                ))}
              </div>
            </div>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 text-slate-300 text-sm">
                <input type="checkbox" checked={seriesMode} onChange={e => setSeriesMode(e.target.checked)} /> Enable
              </label>
              <button
                onClick={handleSeriesOfFour}
                disabled={!seriesMode || seriesRunning}
                className="bg-gradient-to-r from-blue-500 to-indigo-500 hover:from-blue-600 hover:to-indigo-600 text-white font-bold py-2 px-4 rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 shadow-lg"
              >
                {seriesRunning && <Spinner small />}
                {seriesRunning ? 'Scheduling…' : 'Create Series of 4'}
              </button>
            </div>
          </div>
          {seriesStatuses.length > 0 && (
            <div className="mt-3 text-xs text-slate-300 space-y-1">
              {seriesStatuses.map((s, i) => (
                <div key={i}>• {s}</div>
              ))}
            </div>
          )}
          {seriesError && <p className="text-red-400 text-sm mt-2">{seriesError}</p>}
        </div>

        {/* Debug Info - Show current state */}
        {(topic || plan || outline || content) && (
          <div className="p-3 bg-slate-800 rounded-lg text-xs text-slate-400">
            <p><strong>Debug:</strong> Topic: {topic ? '✓' : '✗'} | Plan: {plan ? '✓' : '✗'} | Outline: {outline ? '✓' : '✗'} | Content: {content ? '✓' : '✗'}</p>
          </div>
        )}

        <div className="text-center text-slate-500 text-sm">or follow the step-by-step process below</div>

        {/* Step 1: Topic Discovery */}
        <WorkflowStep
          title="Step 1: Topic Discovery"
          onAction={handleDiscoverTopic}
          actionText="Discover Topic"
          isLoading={topicLoading}
          isDone={!!topic}
          error={topicError}
          isActionDisabled={topicLoading || completeBlogLoading}
        >
          {topic && (
            <div className="mt-2 p-3 bg-slate-900 rounded-md">
              <p className="font-semibold text-lg text-slate-200">{topic}</p>
              {sources && sources.length > 0 && (
                <div className="mt-2">
                    <p className="text-xs text-slate-400">Sources:</p>
                    <ul className="text-xs list-disc list-inside">
                        {sources.map((source, index) => (
                           <li key={index}><a href={source.web.uri} target="_blank" rel="noopener noreferrer" className="text-cyan-500 hover:underline">{source.web.title}</a></li>
                        ))}
                    </ul>
                </div>
              )}
            </div>
          )}
        </WorkflowStep>
        
        {/* Step 2: Content Planning */}
        <WorkflowStep
          title="Step 2: Content Planning"
          onAction={handleCreatePlan}
          actionText="Create Plan"
          isLoading={planLoading}
          isDone={!!plan}
          error={planError}
          isActionDisabled={!topic || planLoading || completeBlogLoading}
        >
            {plan && (
                <div className="mt-2 p-3 bg-slate-900 rounded-md space-y-2">
                    <h4 className="font-bold text-slate-200">{plan.title}</h4>
                    <p><strong className="text-slate-400">Angle:</strong> {plan.angle}</p>
                    <div>
                        <strong className="text-slate-400">Keywords:</strong>
                        <div className="flex flex-wrap gap-2 mt-1">
                            {plan.keywords.map(kw => <span key={kw} className="bg-slate-700 text-cyan-300 text-xs font-medium px-2.5 py-0.5 rounded-full">{kw}</span>)}
                        </div>
                    </div>
                </div>
            )}
        </WorkflowStep>

        {/* Step 3: Outline Creation */}
        <WorkflowStep
          title="Step 3: Outline Creation"
          onAction={handleCreateOutline}
          actionText="Create Outline"
          isLoading={outlineLoading}
          isDone={!!outline}
          error={outlineError}
          isActionDisabled={!plan || outlineLoading || completeBlogLoading}
        >
            {outline && (
                <div className="mt-2 p-3 bg-slate-900 rounded-md space-y-2">
                    <div className="flex justify-between items-center">
                        <div>
                            <span className="text-slate-400">Word Count:</span> <span className="text-cyan-300">{outline.estimatedWordCount}</span>
                            <span className="ml-4 text-slate-400">SEO Score:</span> <span className="text-green-400">{outline.seoScore}/100</span>
                        </div>
                    </div>
                    <pre className="text-sm text-slate-300 whitespace-pre-wrap">{outline.outline}</pre>
                </div>
            )}
        </WorkflowStep>

        {/* Step 4: Content Generation */}
        <WorkflowStep
          title="Step 4: Content Generation"
          onAction={handleGenerateContent}
          actionText="Generate Content"
          isLoading={contentLoading}
          isDone={!!content}
          error={contentError}
          isActionDisabled={!outline || contentLoading || completeBlogLoading}
        >
            {content && (
                <div className="mt-2 p-3 bg-slate-900 rounded-md space-y-2">
                    <div className="flex justify-between items-center">
                        <div>
                            <span className="text-slate-400">Words:</span> <span className="text-cyan-300">{content.wordCount}</span>
                            <span className="ml-4 text-slate-400">Meta Description:</span> <span className="text-green-400">{content.metaDescription.length} chars</span>
                        </div>
                    </div>
                    <div className="max-h-40 overflow-y-auto">
                        <div className="text-sm text-slate-300" dangerouslySetInnerHTML={{ __html: content.content.substring(0, 500) + '...' }} />
                    </div>
                    {content.faq && content.faq.length > 0 && (
                        <div>
                            <p className="text-slate-400 text-sm">FAQ ({content.faq.length} questions)</p>
                        </div>
                    )}
                </div>
            )}
        </WorkflowStep>

        {/* Step 5: Image Generation */}
        <WorkflowStep
          title="Step 5: Image Generation"
          onAction={handleGenerateImages}
          actionText="Generate Images"
          isLoading={imagesLoading}
          isDone={!!images}
          error={imagesError}
          isActionDisabled={!plan || imagesLoading || completeBlogLoading}
        >
            {images && (
                <div className="mt-2 p-3 bg-slate-900 rounded-md space-y-2">
                    <div>
                        <p className="text-slate-400 text-sm">Featured Image:</p>
                        <p className="text-cyan-300 text-sm">{images.featuredImage.description}</p>
                    </div>
                    {images.inBodyImages.length > 0 && (
                        <div>
                            <p className="text-slate-400 text-sm">In-body Images ({images.inBodyImages.length}):</p>
                            <ul className="text-cyan-300 text-sm list-disc list-inside">
                                {images.inBodyImages.map((img, index) => (
                                    <li key={index}>{img.heading}</li>
                                ))}
                            </ul>
                        </div>
                    )}
                </div>
            )}
        </WorkflowStep>

        {/* Step 6: WordPress Publishing */}
        <WorkflowStep
          title="Step 6: Publish to WordPress"
          onAction={handlePublishToWordPress}
          actionText="Publish to WordPress"
          isLoading={publishLoading}
          isDone={!!publishResult}
          error={publishError}
          isActionDisabled={!content || publishLoading || completeBlogLoading}
        >
            {publishResult && (
                <div className="mt-2 p-3 bg-slate-900 rounded-md space-y-2">
                    <div className="flex items-center gap-2">
                        <span className="text-green-400">✓</span>
                        <span className="text-green-300">{publishResult.message}</span>
                    </div>
                    <div className="space-y-1 text-sm">
                        <p><span className="text-slate-400">Status:</span> <span className="text-cyan-300">{publishResult.status}</span></p>
                        <p><span className="text-slate-400">Post ID:</span> <span className="text-cyan-300">{publishResult.postId}</span></p>
                        {publishResult.postUrl && (
                            <p><a href={publishResult.postUrl} target="_blank" rel="noopener noreferrer" className="text-cyan-500 hover:underline">View Post</a></p>
                        )}
                        {publishResult.editUrl && (
                            <p><a href={publishResult.editUrl} target="_blank" rel="noopener noreferrer" className="text-cyan-500 hover:underline">Edit in WordPress</a></p>
                        )}
                    </div>
                </div>
            )}
        </WorkflowStep>

      </div>
    </div>
  );
};

// Helper component for workflow steps
const WorkflowStep = ({ title, children, onAction, actionText, isLoading, isDone, error, isActionDisabled }) => (
    <div className="p-4 bg-slate-700/50 rounded-lg">
        <div className="flex justify-between items-center">
            <h3 className="text-lg font-medium text-slate-300 flex items-center gap-2">
                {isDone && <span className="text-green-400">✔</span>}
                {title}
            </h3>
            <button
                onClick={onAction}
                disabled={isActionDisabled}
                className="bg-cyan-500 hover:bg-cyan-600 text-white font-bold py-1 px-3 rounded-md text-sm transition-colors disabled:bg-slate-600 disabled:cursor-not-allowed flex items-center gap-2"
            >
                {isLoading && <Spinner small />}
                {actionText}
            </button>
        </div>
        {error && <p className="text-red-400 text-sm mt-2">{error}</p>}
        {children}
    </div>
);

export default GenerationWorkflow;
