export interface TagGroup {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  isSingleSelect: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  tags?: Tag[];
}

export interface Tag {
  id: string;
  tenantId: string;
  groupId: string | null;
  name: string;
  color: string | null;
  description: string | null;
  isActive: boolean;
  usageCount: number;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTagInput {
  name: string;
  color?: string | null;
  groupId?: string | null;
  description?: string | null;
}

export interface UpdateTagInput {
  name?: string;
  color?: string | null;
  groupId?: string | null;
  description?: string | null;
  isActive?: boolean;
  sortOrder?: number;
}

export interface TagFilters {
  groupId?: string;
  isActive?: boolean;
  search?: string;
}

export interface TagFilterParams {
  tagIds?: string[];
  tagMode?: 'any' | 'all';
  excludeTagIds?: string[];
  untaggedOnly?: boolean;
}

export interface SavedReportFilter {
  id: string;
  tenantId: string;
  name: string;
  reportType: string;
  filters: Record<string, unknown>;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}
