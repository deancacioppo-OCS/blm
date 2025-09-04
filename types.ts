export interface Client {
  id: string;
  name: string;
  industry: string;
  websiteUrl: string;
  sitemapUrl?: string;
  uniqueValueProp: string;
  brandVoice: string;
  contentStrategy: string;
  wp: { url: string; username: string; appPassword?: string };
  sitemapUrls?: string[];
  usedTopics?: string[];
}

export interface BlogPost {
  topic: string;
  title: string;
  angle: string;
  keywords: string[];
  outline: string;
  content: string; // HTML
  featuredImageBase64: string;
  inBodyImages: { heading: string; base64: string }[];
  faq: { question: string; answer: string }[];
}

export interface BlogPlan {
  title: string;
  angle: string;
  keywords: string[];
}

export interface BlogOutline {
  outline: string;
  estimatedWordCount: number;
  seoScore: number;
}

export interface BlogContent {
  content: string;
  wordCount: number;
  metaDescription: string;
  faq: { question: string; answer: string }[];
}

export interface BlogImages {
  featuredImage: { imageBase64: string; altText: string; description: string; specifications: string };
  inBodyImages: { heading: string; description: string; placeholder: string }[];
}

export interface CompleteBlog {
  topic: string;
  sources: any[];
  plan: BlogPlan;
  content: BlogContent;
  readyToPublish: boolean;
}

export interface WordPressPublishResult {
  success: boolean;
  postId: number;
  postUrl: string;
  editUrl: string;
  status: string;
  message: string;
}


export enum GenerationStep {
  TOPIC = 'Topic Discovery',
  PLAN = 'Content Planning',
  STRUCTURE = 'Outline Creation',
  CONTENT = 'Content Generation',
  IMAGES = 'Image Creation',
  SEO = 'SEO Enhancement',
}

export type StepStatus = 'pending' | 'in-progress' | 'completed' | 'error';