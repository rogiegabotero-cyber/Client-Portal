/**
 * HHI Invoice Component - Editable JSX for External Developers
 * 
 * This is a complete, standalone React component that you can:
 * 1. Copy into your React project
 * 2. Edit the styling, layout, and behavior
 * 3. Customize the hardcoded invoice data and theming
 * 
 * REQUIREMENTS:
 * - React 18+
 * - Styled-components (npm install styled-components)
 * 
 * USAGE:
 * import InvoiceComponent from './InvoiceComponent';
 * 
 * <InvoiceComponent />
 */

import { useState, useMemo } from 'react';
import styled, { ThemeProvider } from 'styled-components';
import { FileText, Download, ExternalLink, RefreshCw, Search, Filter } from 'lucide-react';

// ============================================
// EDIT SECTION 1: THEME CONFIGURATION
// ============================================
// Modify these colors and values to match your brand

const defaultTheme = {
  // Primary brand color (buttons, links, accents)
  primary: '#dc2626',
  primaryHover: '#b91c1c',
  
  // Background colors
  background: '#ffffff',
  cardBackground: '#ffffff',
  headerBackground: '#f9fafb',
  hoverBackground: '#f3f4f6',
  
  // Text colors
  text: '#1f2937',
  textSecondary: '#6b7280',
  textMuted: '#9ca3af',
  
  // Border colors
  border: '#e5e7eb',
  borderLight: '#f3f4f6',
  
  // Status colors
  statusPaid: { bg: '#dcfce7', text: '#166534' },
  statusPending: { bg: '#fef3c7', text: '#92400e' },
  statusOverdue: { bg: '#fee2e2', text: '#991b1b' },
  statusDefault: { bg: '#f3f4f6', text: '#6b7280' },
  
  // Typography
  fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  fontSize: {
    xs: '0.75rem',
    sm: '0.875rem',
    base: '1rem',
    lg: '1.125rem',
    xl: '1.25rem',
    '2xl': '1.5rem',
  },
  
  // Spacing
  spacing: {
    xs: '4px',
    sm: '8px',
    md: '16px',
    lg: '24px',
    xl: '32px',
  },
  
  // Border radius
  borderRadius: {
    sm: '4px',
    md: '8px',
    lg: '12px',
    full: '9999px',
  },
  
  // Shadows
  shadow: {
    sm: '0 1px 2px rgba(0,0,0,0.05)',
    md: '0 4px 6px rgba(0,0,0,0.1)',
    lg: '0 10px 15px rgba(0,0,0,0.1)',
  },
};

const HARDCODED_INVOICES = [
  {
    id: 'inv-1001',
    invoiceNumber: 'INV-1001',
    clientName: 'Acme Logistics',
    invoiceDate: '2026-03-01',
    dueDate: '2026-03-15',
    amount: 1250.0,
    status: 'Paid',
    currency: 'USD',
    description: 'Monthly logistics support',
    billTo: { name: 'Acme Logistics' },
  },
  {
    id: 'inv-1002',
    invoiceNumber: 'INV-1002',
    clientName: 'Northline Retail',
    invoiceDate: '2026-03-05',
    dueDate: '2026-03-20',
    amount: 890.5,
    status: 'Pending',
    currency: 'USD',
    description: 'Warehouse handling services',
    billTo: { name: 'Northline Retail' },
  },
  {
    id: 'inv-1003',
    invoiceNumber: 'INV-1003',
    clientName: 'Blue Horizon Foods',
    invoiceDate: '2026-02-12',
    dueDate: '2026-02-27',
    amount: 1640.75,
    status: 'Overdue',
    currency: 'USD',
    description: 'Cold-chain transportation',
    billTo: { name: 'Blue Horizon Foods' },
  },
  {
    id: 'inv-1004',
    invoiceNumber: 'INV-1004',
    clientName: 'Summit Industrial',
    invoiceDate: '2026-03-10',
    dueDate: '2026-03-25',
    amount: 720.0,
    status: 'Paid',
    currency: 'USD',
    description: 'Dispatch and route optimization',
    billTo: { name: 'Summit Industrial' },
  },
];

// Dark theme variant - optional preset
const DARK_THEME = {
  ...defaultTheme,
  primary: '#f87171',
  primaryHover: '#ef4444',
  background: '#111827',
  cardBackground: '#1f2937',
  headerBackground: '#1f2937',
  hoverBackground: '#374151',
  text: '#f9fafb',
  textSecondary: '#9ca3af',
  textMuted: '#6b7280',
  border: '#374151',
  borderLight: '#4b5563',
  shadow: {
    sm: '0 1px 2px rgba(0,0,0,0.3)',
    md: '0 4px 6px rgba(0,0,0,0.4)',
    lg: '0 10px 15px rgba(0,0,0,0.5)',
  },
};

// ============================================
// EDIT SECTION 2: STYLED COMPONENTS
// ============================================
// Modify these components to change the appearance

const Container = styled.div`
  font-family: ${props => props.theme.fontFamily};
  background: ${props => props.theme.background};
  color: ${props => props.theme.text};
  min-height: 100vh;
  padding: ${props => props.theme.spacing.lg};
  box-sizing: border-box;
`;

const Header = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: ${props => props.theme.spacing.lg};
  flex-wrap: wrap;
  gap: ${props => props.theme.spacing.md};
  
  @media (max-width: 640px) {
    flex-direction: column;
  }
`;

const TitleSection = styled.div`
  flex: 1;
`;

const Title = styled.h1`
  font-size: ${props => props.theme.fontSize['2xl']};
  font-weight: 700;
  color: ${props => props.theme.text};
  margin: 0 0 ${props => props.theme.spacing.xs} 0;
`;

const Subtitle = styled.p`
  font-size: ${props => props.theme.fontSize.sm};
  color: ${props => props.theme.textSecondary};
  margin: 0;
`;

const Actions = styled.div`
  display: flex;
  gap: ${props => props.theme.spacing.sm};
  flex-wrap: wrap;
`;

const Button = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 10px 16px;
  border-radius: ${props => props.theme.borderRadius.md};
  border: 1px solid ${props => props.theme.border};
  background: ${props => props.$variant === 'primary' ? props.theme.primary : props.theme.cardBackground};
  color: ${props => props.$variant === 'primary' ? '#ffffff' : props.theme.text};
  font-size: ${props => props.theme.fontSize.sm};
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
  
  &:hover {
    background: ${props => props.$variant === 'primary' ? props.theme.primaryHover : props.theme.hoverBackground};
    border-color: ${props => props.$variant === 'primary' ? props.theme.primaryHover : props.theme.textMuted};
    transform: translateY(-1px);
  }
  
  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    transform: none;
  }
`;

const SearchBar = styled.div`
  display: flex;
  gap: ${props => props.theme.spacing.sm};
  margin-bottom: ${props => props.theme.spacing.md};
  flex-wrap: wrap;
`;

const Input = styled.input`
  flex: 1;
  min-width: 200px;
  padding: 10px 14px;
  border: 1px solid ${props => props.theme.border};
  border-radius: ${props => props.theme.borderRadius.md};
  background: ${props => props.theme.cardBackground};
  color: ${props => props.theme.text};
  font-size: ${props => props.theme.fontSize.sm};
  
  &:focus {
    outline: none;
    border-color: ${props => props.theme.primary};
    box-shadow: 0 0 0 3px ${props => props.theme.primary}20;
  }
  
  &::placeholder {
    color: ${props => props.theme.textMuted};
  }
`;

const Select = styled.select`
  padding: 10px 14px;
  border: 1px solid ${props => props.theme.border};
  border-radius: ${props => props.theme.borderRadius.md};
  background: ${props => props.theme.cardBackground};
  color: ${props => props.theme.text};
  font-size: ${props => props.theme.fontSize.sm};
  cursor: pointer;
  
  &:focus {
    outline: none;
    border-color: ${props => props.theme.primary};
  }
`;

const TableContainer = styled.div`
  background: ${props => props.theme.cardBackground};
  border-radius: ${props => props.theme.borderRadius.lg};
  border: 1px solid ${props => props.theme.border};
  overflow: hidden;
  box-shadow: ${props => props.theme.shadow.sm};
`;

const Table = styled.table`
  width: 100%;
  border-collapse: collapse;
  font-size: ${props => props.theme.fontSize.sm};
`;

const TableHead = styled.thead`
  background: ${props => props.theme.headerBackground};
  border-bottom: 2px solid ${props => props.theme.border};
`;

const TableHeaderCell = styled.th`
  padding: 14px 16px;
  text-align: left;
  font-weight: 600;
  color: ${props => props.theme.text};
  text-transform: uppercase;
  font-size: ${props => props.theme.fontSize.xs};
  letter-spacing: 0.5px;
  white-space: nowrap;
  cursor: ${props => props.$sortable ? 'pointer' : 'default'};
  
  &:hover {
    background: ${props => props.$sortable ? props.theme.hoverBackground : 'transparent'};
  }
`;

const TableRow = styled.tr`
  border-bottom: 1px solid ${props => props.theme.borderLight};
  transition: background 0.15s;
  
  &:hover {
    background: ${props => props.theme.hoverBackground};
  }
  
  &:last-child {
    border-bottom: none;
  }
`;

const TableCell = styled.td`
  padding: 14px 16px;
  color: ${props => props.theme.text};
`;

const StatusBadge = styled.span`
  display: inline-flex;
  align-items: center;
  padding: 4px 12px;
  border-radius: ${props => props.theme.borderRadius.full};
  font-size: ${props => props.theme.fontSize.xs};
  font-weight: 600;
  background: ${props => {
    switch (props.$status?.toLowerCase()) {
      case 'paid': return props.theme.statusPaid.bg;
      case 'pending': return props.theme.statusPending.bg;
      case 'overdue': return props.theme.statusOverdue.bg;
      default: return props.theme.statusDefault.bg;
    }
  }};
  color: ${props => {
    switch (props.$status?.toLowerCase()) {
      case 'paid': return props.theme.statusPaid.text;
      case 'pending': return props.theme.statusPending.text;
      case 'overdue': return props.theme.statusOverdue.text;
      default: return props.theme.statusDefault.text;
    }
  }};
`;

const Amount = styled.span`
  font-weight: 600;
  color: ${props => props.$status === 'overdue' ? props.theme.statusOverdue.text : props.theme.text};
`;

const EmptyState = styled.div`
  text-align: center;
  padding: 60px 20px;
  color: ${props => props.theme.textSecondary};
`;

const EmptyStateIcon = styled.div`
  width: 64px;
  height: 64px;
  margin: 0 auto 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: ${props => props.theme.headerBackground};
  border-radius: 50%;
  color: ${props => props.theme.textMuted};
`;

const Pagination = styled.div`
  display: flex;
  justify-content: center;
  align-items: center;
  gap: ${props => props.theme.spacing.sm};
  margin-top: ${props => props.theme.spacing.lg};
  padding: ${props => props.theme.spacing.md};
`;

const PageButton = styled.button`
  padding: 8px 12px;
  border: 1px solid ${props => props.theme.border};
  border-radius: ${props => props.theme.borderRadius.md};
  background: ${props => props.$active ? props.theme.primary : props.theme.cardBackground};
  color: ${props => props.$active ? '#ffffff' : props.theme.text};
  font-size: ${props => props.theme.fontSize.sm};
  cursor: pointer;
  
  &:hover:not(:disabled) {
    background: ${props => props.$active ? props.theme.primaryHover : props.theme.hoverBackground};
  }
  
  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`;

// ============================================
// EDIT SECTION 3: UTILITY FUNCTIONS
// ============================================
// Helper functions for formatting

const formatCurrency = (amount, currency = 'USD') => {
  const num = parseFloat(amount);
  if (isNaN(num)) return '-';
  
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency,
  }).format(num);
};

const formatDate = (dateString) => {
  if (!dateString) return '-';
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
};

// ============================================
// MAIN COMPONENT
// ============================================

const InvoiceComponent = ({
  // EDIT: Change these props or set defaults
  title = 'Invoices',
  theme = defaultTheme, // or use DARK_THEME
  pageSize = 10,
  showExport = true,
  showFilters = true,
  onInvoiceClick = null, // callback(invoice) when row is clicked
}) => {
  // Offline hardcoded data only (no API fetch)
  const invoices = HARDCODED_INVOICES;
  const [currentPage, setCurrentPage] = useState(1);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [sortField, setSortField] = useState('createdAt');
  const [sortDirection, setSortDirection] = useState('desc');

  const resetInvoicesView = () => {
    setSearchQuery('');
    setStatusFilter('all');
    setSortField('createdAt');
    setSortDirection('desc');
    setCurrentPage(1);
  };

  // Filter and sort invoices
  const filteredInvoices = useMemo(() => {
    let result = [...invoices];
    
    // Apply search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      result = result.filter(invoice => 
        (invoice.invoiceNumber || '').toLowerCase().includes(query) ||
        (invoice.clientName || '').toLowerCase().includes(query) ||
        (invoice.billTo?.name || '').toLowerCase().includes(query) ||
        (invoice.description || '').toLowerCase().includes(query)
      );
    }
    
    // Apply status filter
    if (statusFilter !== 'all') {
      result = result.filter(invoice => 
        (invoice.status || 'pending').toLowerCase() === statusFilter
      );
    }
    
    // Apply sorting
    result.sort((a, b) => {
      let aVal = a[sortField] || '';
      let bVal = b[sortField] || '';
      
      // Handle dates
      if (sortField.includes('Date') || sortField === 'createdAt') {
        aVal = new Date(aVal).getTime();
        bVal = new Date(bVal).getTime();
      }
      // Handle numbers
      else if (sortField === 'amount') {
        aVal = parseFloat(aVal) || 0;
        bVal = parseFloat(bVal) || 0;
      }
      
      if (sortDirection === 'asc') {
        return aVal > bVal ? 1 : -1;
      } else {
        return aVal < bVal ? 1 : -1;
      }
    });
    
    return result;
  }, [invoices, searchQuery, statusFilter, sortField, sortDirection]);

  // Pagination calculations
  const totalPages = Math.ceil(filteredInvoices.length / pageSize);
  const startIndex = (currentPage - 1) * pageSize;
  const paginatedInvoices = filteredInvoices.slice(startIndex, startIndex + pageSize);

  // Handle sort click
  const handleSort = (field) => {
    setCurrentPage(1);
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('desc');
    }
  };

  // Export to CSV
  const exportCSV = () => {
    const headers = ['Invoice #', 'Client', 'Date', 'Due Date', 'Amount', 'Status', 'Description'];
    const rows = filteredInvoices.map(inv => [
      inv.invoiceNumber || inv.id,
      inv.clientName || inv.billTo?.name || '',
      formatDate(inv.invoiceDate || inv.createdAt),
      formatDate(inv.dueDate),
      inv.amount,
      inv.status || 'Pending',
      inv.description || ''
    ]);
    
    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.map(cell => `"${cell}"`).join(','))
    ].join('\n');
    
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `invoices-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    window.URL.revokeObjectURL(url);
  };

  return (
    <ThemeProvider theme={theme}>
      <Container>
        {/* Header */}
        <Header>
          <TitleSection>
            <Title>{title}</Title>
            <Subtitle>
              {filteredInvoices.length} {filteredInvoices.length === 1 ? 'invoice' : 'invoices'}
              {filteredInvoices.length !== invoices.length && ` (of ${invoices.length} total)`}
            </Subtitle>
          </TitleSection>
          
          <Actions>
            <Button onClick={resetInvoicesView}>
              <RefreshCw size={16} />
              Refresh
            </Button>
            
            {showExport && (
              <Button onClick={exportCSV} $variant="primary">
                <Download size={16} />
                Export CSV
              </Button>
            )}
          </Actions>
        </Header>

        {/* Filters */}
        {showFilters && (
          <SearchBar>
            <Input
              type="text"
              placeholder="Search invoices..."
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setCurrentPage(1);
              }}
              style={{ flex: 2 }}
            />
            <Select
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setCurrentPage(1);
              }}
            >
              <option value="all">All Status</option>
              <option value="paid">Paid</option>
              <option value="pending">Pending</option>
              <option value="overdue">Overdue</option>
            </Select>
          </SearchBar>
        )}

        {/* Invoice Table */}
        <TableContainer>
          {filteredInvoices.length === 0 ? (
            <EmptyState>
              <EmptyStateIcon>
                <FileText size={32} />
              </EmptyStateIcon>
              <h3>No invoices found</h3>
              <p>{searchQuery || statusFilter !== 'all' ? 'Try adjusting your filters' : 'Get started by creating your first invoice'}</p>
            </EmptyState>
          ) : (
            <Table>
              <TableHead>
                <tr>
                  <TableHeaderCell 
                    $sortable 
                    onClick={() => handleSort('invoiceNumber')}
                  >
                    Invoice # {sortField === 'invoiceNumber' && (sortDirection === 'asc' ? '↑' : '↓')}
                  </TableHeaderCell>
                  <TableHeaderCell 
                    $sortable 
                    onClick={() => handleSort('clientName')}
                  >
                    Client {sortField === 'clientName' && (sortDirection === 'asc' ? '↑' : '↓')}
                  </TableHeaderCell>
                  <TableHeaderCell 
                    $sortable 
                    onClick={() => handleSort('invoiceDate')}
                  >
                    Date {sortField === 'invoiceDate' && (sortDirection === 'asc' ? '↑' : '↓')}
                  </TableHeaderCell>
                  <TableHeaderCell 
                    $sortable 
                    onClick={() => handleSort('dueDate')}
                  >
                    Due Date {sortField === 'dueDate' && (sortDirection === 'asc' ? '↑' : '↓')}
                  </TableHeaderCell>
                  <TableHeaderCell 
                    $sortable 
                    onClick={() => handleSort('amount')}
                  >
                    Amount {sortField === 'amount' && (sortDirection === 'asc' ? '↑' : '↓')}
                  </TableHeaderCell>
                  <TableHeaderCell 
                    $sortable 
                    onClick={() => handleSort('status')}
                  >
                    Status {sortField === 'status' && (sortDirection === 'asc' ? '↑' : '↓')}
                  </TableHeaderCell>
                  <TableHeaderCell>Actions</TableHeaderCell>
                </tr>
              </TableHead>
              <tbody>
                {paginatedInvoices.map((invoice) => (
                  <TableRow 
                    key={invoice.id}
                    onClick={() => onInvoiceClick && onInvoiceClick(invoice)}
                    style={{ cursor: onInvoiceClick ? 'pointer' : 'default' }}
                  >
                    <TableCell>
                      <strong>{invoice.invoiceNumber || invoice.id}</strong>
                    </TableCell>
                    <TableCell>
                      {invoice.clientName || invoice.billTo?.name || '-'}
                    </TableCell>
                    <TableCell>
                      {formatDate(invoice.invoiceDate || invoice.createdAt)}
                    </TableCell>
                    <TableCell>
                      {formatDate(invoice.dueDate)}
                    </TableCell>
                    <TableCell>
                      <Amount $status={invoice.status}>
                        {formatCurrency(invoice.amount, invoice.currency)}
                      </Amount>
                    </TableCell>
                    <TableCell>
                      <StatusBadge $status={invoice.status}>
                        {invoice.status || 'Pending'}
                      </StatusBadge>
                    </TableCell>
                    <TableCell>
                      <Button 
                        as="a"
                        href={`/invoices/${invoice.id}`}
                        onClick={(e) => e.stopPropagation()}
                        style={{ padding: '6px 12px', fontSize: '0.75rem' }}
                      >
                        <ExternalLink size={14} />
                        View
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </tbody>
            </Table>
          )}
        </TableContainer>

        {/* Pagination */}
        {totalPages > 1 && (
          <Pagination>
            <PageButton 
              onClick={() => setCurrentPage(currentPage - 1)}
              disabled={currentPage === 1}
            >
              Previous
            </PageButton>
            
            {Array.from({ length: totalPages }, (_, i) => i + 1).map(page => (
              <PageButton
                key={page}
                $active={page === currentPage}
                onClick={() => setCurrentPage(page)}
              >
                {page}
              </PageButton>
            ))}
            
            <PageButton
              onClick={() => setCurrentPage(currentPage + 1)}
              disabled={currentPage === totalPages}
            >
              Next
            </PageButton>
          </Pagination>
        )}
      </Container>
    </ThemeProvider>
  );
};

// Add spin animation for loading
const style = document.createElement('style');
style.textContent = `
  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }
`;
document.head.appendChild(style);

export default InvoiceComponent;

// ============================================
// EXAMPLE USAGE (copy into your App.jsx or page)
// ============================================
/*
import InvoiceComponent from './InvoiceComponent';

function App() {
  return (
    <InvoiceComponent
      title="My Company Invoices"
      theme={{
        primary: '#3b82f6', // Change to your brand color
        background: '#ffffff',
        // ... customize other theme values
      }}
      pageSize={20}
      showExport={true}
      showFilters={true}
      onInvoiceClick={(invoice) => console.log('Clicked:', invoice)}
    />
  );
}
*/
